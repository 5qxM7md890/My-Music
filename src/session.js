// src/session.js
const { ChannelType } = require("discord.js");

// البحث الافتراضي صار "ذكي":
// - إذا كان النود الأساسي (سيرفرك) متصل -> نبحث SoundCloud (scsearch:)
// - إذا تعطل/فصل النود الأساسي -> نبحث YouTube (ytsearch:)
// ويمكنك التحكم عبر .env:
//   LAVALINK_PRIMARY_NAME=vortex-ny2
//   PRIMARY_SEARCH_PREFIX=scsearch:
//   FALLBACK_SEARCH_PREFIX=ytsearch:
//   SC_TO_YT_FALLBACK=1
const PRIMARY_NODE_NAME =
  process.env.LAVALINK_PRIMARY_NAME ||
  process.env.PRIMARY_NODE_NAME ||
  process.env.LAVALINK_NAME_1 ||
  "main";

const PRIMARY_SEARCH_PREFIX = process.env.PRIMARY_SEARCH_PREFIX || "scsearch:";
const FALLBACK_SEARCH_PREFIX = process.env.FALLBACK_SEARCH_PREFIX || "ytsearch:";
const SC_TO_YT_FALLBACK = String(process.env.SC_TO_YT_FALLBACK || "1") === "1";

// Auto-migrate back to the primary node when it becomes available again.
// - AUTO_MIGRATE_BACK_TO_PRIMARY=1  (default: 0)
// - AUTO_MIGRATE_BACK_RESUME=1      (try to resume current track position; default: 1)
// - AUTO_MIGRATE_BACK_STAGGER_MS=700 (delay between sessions to avoid spikes)
const AUTO_MIGRATE_BACK_TO_PRIMARY = String(process.env.AUTO_MIGRATE_BACK_TO_PRIMARY || "0") === "1";
const AUTO_MIGRATE_BACK_RESUME = String(process.env.AUTO_MIGRATE_BACK_RESUME || "1") === "1";
// لو كان التراك الحالي YouTube (لأننا كنا على fallback) والنود الأساسي ما يدعم YouTube غالباً،
// نؤجل الرجوع للأساسي لين يخلص التراك الحالي (بدون ما نقطع الصوت). تقدر تجبره عبر:
// AUTO_MIGRATE_BACK_ALLOW_YT=1
const AUTO_MIGRATE_BACK_ALLOW_YT = String(process.env.AUTO_MIGRATE_BACK_ALLOW_YT || "0") === "1";

// Allow explicit prefixes.
const PREFIXED_SEARCH_REGEX = /^(ytsearch:|ytmsearch:|scsearch:|spsearch:)/i;
const YOUTUBE_PREFIX_REGEX = /^(ytsearch:|ytmsearch:)/i;
const YOUTUBE_URL_REGEX = /(youtube\.com|youtu\.be)/i;


function looksLikeUrl(q) {
  return /^https?:\/\/\S+/i.test(q);
}

// normalizeIdentifier now lives inside the session so it can choose between primary/fallback.

function pickTracksFromResult(result) {
  if (!result) return { type: "empty", tracks: [], playlistName: null };
  const lt = String(result.loadType || "").toLowerCase();

  if (lt === "empty") return { type: "empty", tracks: [], playlistName: null };
  if (lt === "error") return { type: "error", tracks: [], playlistName: null };

  if (lt === "track") return { type: "track", tracks: result.data ? [result.data] : [], playlistName: null };
  if (lt === "search") return { type: "search", tracks: Array.isArray(result.data) ? result.data : [], playlistName: null };

  if (lt === "playlist") {
    const pl = result.data;
    const tracks = Array.isArray(pl?.tracks) ? pl.tracks : [];
    const playlistName = pl?.info?.name || "Playlist";
    return { type: "playlist", tracks, playlistName };
  }

  if (Array.isArray(result.data)) return { type: "search", tracks: result.data, playlistName: null };
  if (result.data?.tracks) return { type: "playlist", tracks: result.data.tracks, playlistName: result.data?.info?.name || "Playlist" };

  return { type: "empty", tracks: [], playlistName: null };
}

function getEndReason(evt) {
  return String(evt?.reason || evt?.data?.reason || evt?.endReason || "").toUpperCase();
}

class MusicSession {
  constructor({ guildId, voiceChannelId, textChannelId, bot, onStateChange }) {
    this.guildId = guildId;
    this.voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId;
    this.bot = bot;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};

    this.player = null;
    this.queue = [];
    this.current = null;

    this.repeatMode = 0; // 0=off,1=track,2=queue
    this.paused = false;

    this._eventsAttached = false;

    // قفل لمنع محاولة join مرتين بنفس الوقت لنفس الجلسة
    this._connecting = null;

    // قفل لمنع تكرار معالجة أخطاء التشغيل بشكل متسلسل
    this._handlingException = false;

    // Tracks that failed to play (to avoid infinite retry loops)
    this._failedIds = new Set();

    // Resume/Recovery state (for Lavalink disconnects)
    this._resumeSnapshot = null;
    this._nodeDown = false;
    this._recovering = null;

    // Auto-migrate back state
    this._migrateBackRequested = false;
    this._migratingBack = false;
  }

  requestMigrateBackToPrimary(reason = "") {
    if (!AUTO_MIGRATE_BACK_TO_PRIMARY) return;
    this._migrateBackRequested = true;
    if (reason) this._migrateBackReason = reason;
  }

  _isOnPrimary() {
    return String(this.player?.node?.name || "") === String(PRIMARY_NODE_NAME);
  }

  _isActivelyPlaying() {
    // best-effort (Shoukaku exposes player.track sometimes)
    return Boolean(this.current) && Boolean(this.player?.track) && !this.paused;
  }

  async migrateBackToPrimary(opts = {}) {
    const resume = typeof opts.resume === "boolean" ? opts.resume : AUTO_MIGRATE_BACK_RESUME;
    const force = String(opts.force || "0") === "1";

    if (!AUTO_MIGRATE_BACK_TO_PRIMARY && !force) return false;
    if (this._migratingBack) return false;
    if (!this._isPrimaryUp()) return false;
    if (this._isOnPrimary()) {
      this._migrateBackRequested = false;
      return true;
    }

    // لو النود الأساسي غالباً SoundCloud فقط، لا نرجع عليه وعندنا YouTube شغال/بالكيو
    // (إلا إذا المستخدم أكد أن الأساسي يدعم YouTube via AUTO_MIGRATE_BACK_ALLOW_YT=1)
    if (!AUTO_MIGRATE_BACK_ALLOW_YT) {
      const ytCurrent = this._isActivelyPlaying() && this._isYouTubeItem(this.current);
      const ytQueued = Array.isArray(this.queue) && this.queue.some((t) => this._isYouTubeItem(t));
      if (ytCurrent || ytQueued) {
        this._migrateBackRequested = true;
        return false;
      }
    }

    // لا نتعارض مع reconnect/recover
    if (this._connecting || this._recovering) {
      this._migrateBackRequested = true;
      return false;
    }

    this._migratingBack = true;
    const snapshot = this._makeResumeSnapshot();

    try {
      // اقطع الاتصال الحالي
      try { await this.bot?.shoukaku?.leaveVoiceChannel?.(this.guildId); } catch {}
      this.player = null;
      this._eventsAttached = false;

      // اتصل من جديد (ensureConnected يفضل النود الأساسي إذا كان متصل)
      await this.ensureConnected();

      // رجع الـQueue/الحالة
      if ((!this.queue || this.queue.length === 0) && snapshot.queue?.length) this.queue = snapshot.queue;
      this.repeatMode = snapshot.repeatMode ?? this.repeatMode;
      this.paused = Boolean(snapshot.paused);

      // حاول نكمل نفس التراك إذا كنا فعليًا نلعب وقت الهجرة
      if (resume && snapshot.current && snapshot.current.uri) {
        const uri = String(snapshot.current.uri);
        let picked = null;
        // resolve على النود الأساسي
        const r = await this.player.node.rest.resolve(looksLikeUrl(uri) ? uri : `${FALLBACK_SEARCH_PREFIX}${snapshot.current.title}`)
          .catch(() => null);
        const pp = pickTracksFromResult(r);
        if (pp?.tracks?.length) {
          picked = this._toItem(pp.tracks[0], snapshot.current.requester, snapshot.current.playlist || null);
        }

        if (picked?.encoded) {
          this.current = picked;
          await this._play(picked);
          const pos = snapshot.position;
          if (typeof pos === "number" && pos > 0 && typeof this.player?.seekTo === "function") {
            await this.player.seekTo(pos).catch(() => {});
          }
          if (snapshot.paused && typeof this.player?.setPaused === "function") {
            await this.player.setPaused(true).catch(() => {});
            this.paused = true;
          }
        }
      }

      this._migrateBackRequested = false;
      this.onStateChange();
      console.log(`[MIGRATE] Session moved back to primary (${PRIMARY_NODE_NAME}) in <#${this.voiceChannelId}>`);
      return true;
    } catch (e) {
      console.warn(`[MIGRATE] Failed to migrate back to primary: ${e?.message || e}`);
      this._migrateBackRequested = true;
      return false;
    } finally {
      this._migratingBack = false;
    }
  }

  _isNodeConnectedByName(name) {
    if (!this.bot?.shoukaku) return false;
    const n = this.bot.shoukaku.nodes?.get?.(name);
    const st = n?.state;
    return (
      st === 2 ||
      st === 1 ||
      String(st).toUpperCase() === "CONNECTED" ||
      String(st).toUpperCase() === "NEARLY"
    );
  }

  _isPrimaryUp() {
    return this._isNodeConnectedByName(PRIMARY_NODE_NAME);
  }

  _defaultSearchPrefix() {
    // Use SoundCloud only when THIS session is on the primary node and the primary is up.
    const onPrimary = String(this.player?.node?.name || "") === String(PRIMARY_NODE_NAME);
    return (onPrimary && this._isPrimaryUp()) ? PRIMARY_SEARCH_PREFIX : FALLBACK_SEARCH_PREFIX;
  }

  _normalizeIdentifier(raw) {
    const query = String(raw || "").trim();
    if (!query) return null;

    if (PREFIXED_SEARCH_REGEX.test(query)) return query;
    if (looksLikeUrl(query)) return query;

    return `${this._defaultSearchPrefix()}${query}`;
  }

  _isSoundCloudItem(item) {
    if (!item) return false;
    const src = String(item.sourceName || "").toLowerCase();
    if (src.includes("soundcloud")) return true;
    const uri = String(item.uri || "");
    return /soundcloud\.com/i.test(uri);
  }

  async _convertToYouTube(item, take = 8) {
    const title = String(item?.title || "").trim();
    if (!title) return null;

    const query = `ytsearch:${title}${item?.author ? " " + item.author : ""}`;
    const resolved = await this.resolve(query).catch(() => null);
    if (!resolved?.ok) return null;

    const tracks = (Array.isArray(resolved.tracks) ? resolved.tracks : []).slice(0, take);
    for (const t of tracks) {
      const info = t?.info || {};
      const id = info.identifier || null;
      if (id && this._failedIds.has(id)) continue;
      const alt = this._toItem(t, item.requester, item.playlist || null);
      return alt;
    }
    return null;
  }

  async _ensurePlayableItem(item) {
    if (!item) return item;
    if (!SC_TO_YT_FALLBACK) return item;

    const onPrimary = String(this.player?.node?.name || "") === String(PRIMARY_NODE_NAME);
    if (this._isSoundCloudItem(item) && (!this._isPrimaryUp() || !onPrimary)) {
      const alt = await this._convertToYouTube(item).catch(() => null);
      if (alt?.encoded) {
        console.warn(`[SC->YT] Primary down/offline -> switching to YouTube: ${alt.title}`);
        return alt;
      }
    }
    return item;
  }

  async ensureConnected() {
    // إذا كان عندنا Player سابق، تأكد أنه صالح (خصوصاً بعد انقطاع/رجوع Lavalink)
    if (this.player) {
      if (this._isPlayerUsable(this.player)) return this.player;
      console.warn("[SESSION] Stale player detected; recreating voice/Lavalink player...");
      try { await this.bot?.shoukaku?.leaveVoiceChannel?.(this.guildId); } catch {}
      this.player = null;
      this._eventsAttached = false;
    }
    if (this._connecting) return await this._connecting;

    // التحقق من اتصال Shoukaku
    if (!this.bot?.shoukaku) {
      throw new Error("NO_LAVALINK_NODE: Shoukaku not initialized");
    }

    const shoukaku = this.bot.shoukaku;

    // لو فيه Player/Connection موجودة مسبقاً لنفس الـ guild، استخدمها بدل join من جديد
    const existingPlayer = shoukaku.players?.get?.(this.guildId) || null;
    if (existingPlayer && !this._isPlayerUsable(existingPlayer)) {
      console.warn("[SESSION] Existing player is stale/unusable; forcing rejoin...");
      await shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
    } else if (existingPlayer) {
      const currentChannel = existingPlayer.connection?.channelId;
      if (currentChannel && currentChannel !== this.voiceChannelId) {
        // لو كان متصل بروم مختلف، افصل وخلّنا نعيد join للروم الصحيح
        await shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
      } else {
        this.player = existingPlayer;
        this._attachEvents();
        return this.player;
      }
    }

    // نغلف عملية الـ join بقفل
    this._connecting = (async () => {

      // انتظر اتصال Lavalink قبل محاولة join (خاصة عند تشغيل 24/7 بسرعة بعد الإقلاع)
      const readyTimeout = Number(process.env.LAVALINK_READY_TIMEOUT_MS || "30000");
      if (typeof this.bot?.waitForNodeReady === "function") {
        await this.bot.waitForNodeReady(readyTimeout).catch(() => false);
      }

// انتظر جاهزية Lavalink (لتجنب No connected nodes عند الإقلاع/إعادة الاتصال)
if (typeof this.bot?.waitForNodeReady === "function") {
  const timeout = Number(process.env.LAVALINK_READY_TIMEOUT_MS || "45000");
  await this.bot.waitForNodeReady(timeout).catch(() => false);
}

// التحقق من وجود عقد Lavalink متصلة
      const nodes = Array.from(shoukaku.nodes.values());
      const connectedNodes = nodes.filter(
        (node) => node && (node.state === 2 || node.state === 1 || String(node.state).toUpperCase() === "CONNECTED")
      ); // 2 = CONNECTED, 1 = NEARLY
    
    if (connectedNodes.length === 0) {
      console.error("[LAVALINK] No connected nodes available");
      console.error("[LAVALINK] Available nodes:", nodes.map(n => ({ 
        name: n.name, 
        state: n.state,
        connected: n.state === 2 
      })));
      throw new Error("NO_LAVALINK_NODE: No Lavalink nodes connected");
    }

      // اختيار أفضل عقدة متصلة (أقل "تكلفة" = أقل ضغط/penalties)
      // بعض الاستضافات العامة تكون قريبة من الحد (players/max) — نحاول نتجنبها.
      const pickPenalty = (n) => {
        const base = Number(n?.penalties ?? n?.stats?.penalties ?? 0) || 0;
        const st = n?.stats || {};
        const players = Number(st.players || 0) || 0;
        const playing = Number(st.playingPlayers || 0) || 0;
        const cpu = Number(st.cpu?.systemLoad || st.cpu?.lavalinkLoad || 0) || 0;
        const memUsed = Number(st.memory?.used || 0) || 0;
        const memCap = Number(st.memory?.reservable || st.memory?.allocated || 0) || 0;
        const memPct = memCap > 0 ? (memUsed / memCap) * 100 : 0;
        // weighting tuned for public nodes
        return base + players * 2 + playing * 2 + cpu * 100 + memPct;
      };
      // الأفضلية للنود الأساسي (سيرفرك) إذا كان متصل.
      // وإذا تعطل/فصل نختار أقل ضغط (penalties) كنود احتياطي.
      const primaryNode = connectedNodes.find((n) => String(n?.name) === String(PRIMARY_NODE_NAME));
      const node = primaryNode || connectedNodes.sort((a, b) => pickPenalty(a) - pickPenalty(b))[0];

      const shardId = this.bot?.client?.shard?.ids?.[0] ?? 0;

      try {
        this.player = await shoukaku.joinVoiceChannel({
          guildId: this.guildId,
          channelId: this.voiceChannelId,
          shardId,
          deaf: false,
          mute: false,
          node: node.name
        }, node.name);

        console.log("[VOICE JOIN]", {
          guildId: this.guildId,
          channelId: this.voiceChannelId,
          node: this.player?.node?.name || node.name,
          player: !!this.player,
        });

        await this._tryUnsuppressStage().catch(() => {});
        this._attachEvents();
        return this.player;
      } catch (error) {
        const msg = String(error?.message || error);
        // أحياناً يحصل AbortError (undici) بسبب timeout/شبكة/IPv6 — جرّب إعادة المحاولة
        if (/AbortError/i.test(msg) || /operation was aborted/i.test(msg)) {
          console.warn('[VOICE JOIN] AbortError, retrying...');
          for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise(r => setTimeout(r, 800 * attempt));
            await shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
            try {
              this.player = await shoukaku.joinVoiceChannel({
                guildId: this.guildId,
                channelId: this.voiceChannelId,
                shardId,
                deaf: false,
                mute: false,
              });
              this._attachEvents();
              return this.player;
            } catch (e) {
              const m2 = String(e?.message || e);
              if (!(/AbortError/i.test(m2) || /operation was aborted/i.test(m2))) throw e;
            }
          }
          throw error;
        }

                // شائع جداً يحصل لما تكون فيه محاولة join ثانية بنفس الوقت أو اتصال مسبق
        if (/already have an existing connection/i.test(msg)) {
          // حاول نلتقط الـ player الموجود
          for (let i = 0; i < 10; i++) {
            const p = shoukaku.players?.get?.(this.guildId);
            if (p) {
              const currentChannel = p.connection?.channelId;
              if (currentChannel && currentChannel !== this.voiceChannelId) {
                await shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
                break;
              }
              this.player = p;
              this._attachEvents();
              return this.player;
            }
            await new Promise((r) => setTimeout(r, 300));
          }

          // لو ما حصلنا player، نفصل ثم نعيد join
          await shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
          this.player = await shoukaku.joinVoiceChannel({
            guildId: this.guildId,
            channelId: this.voiceChannelId,
            shardId,
            deaf: false,
            mute: false,
          });
          this._attachEvents();
          return this.player;
        }

        console.error("[VOICE JOIN ERROR]", error);
        throw new Error(msg);
      }
    })();

    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  async _tryUnsuppressStage() {
    const client = this.bot?.client;
    if (!client) return;

    const ch = await client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!ch) return;

    if (ch.type === ChannelType.GuildStageVoice) {
      const guild = await client.guilds.fetch(this.guildId).catch(() => null);
      if (!guild) return;

      const me = await guild.members.fetchMe().catch(() => null);
      if (!me) return;

      if (me.voice?.suppress) {
        console.log("[STAGE] Trying to unsuppress...");
        await me.voice.setSuppressed(false).catch(() => {});
      }
    }
  }

  _attachEvents() {
    if (!this.player || this._eventsAttached) return;
    this._eventsAttached = true;

    this.player.on("end", async (evt) => {
      try {
        const reason = getEndReason(evt);
        if (reason === "REPLACED") return;
        await this._handleEnd(reason);
      } catch (e) {
        console.error("[END HANDLER ERR]", e);
      }
    });

    this.player.on("exception", async (e) => {
      console.error("[TRACK EXCEPTION]", e);

      // IMPORTANT:
      // Track exceptions should NOT trigger loop/repeat of the same broken track.
      // Also, we try a YouTube fallback (next search result) before moving on.
      if (this._handlingException) return;
      this._handlingException = true;
      try {
        await this._handlePlaybackException(e);
      } catch (err) {
        console.error("[EXCEPTION HANDLER ERR]", err);
        // As a last resort, just move on.
        await this.playNextIfNeeded(true).catch(() => {});
      } finally {
        this._handlingException = false;
      }
    });
    this.player.on("stuck", async (e) => {
      console.error("[TRACK STUCK]", e);
      if (this._handlingException) return;
      this._handlingException = true;
      try {
        // Treat as playback failure and move on.
        await this._handlePlaybackException({ message: "stuck" });
      } catch {}
      finally {
        this._handlingException = false;
      }
    });
    this.player.on("closed", async (e) => {
  console.error("[PLAYER CLOSED]", e);
  await this._handlePlayerClosed(e).catch(() => {});
});
  }

  _extractExceptionMessage(e) {
    const msg =
      e?.exception?.message ||
      e?.exception?.cause ||
      e?.message ||
      e?.error ||
      "";
    return String(msg);
  }

  _youtubeIdFromUri(uri) {
    const u = String(uri || "");
    // youtu.be/<id>
    const short = u.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
    if (short?.[1]) return short[1];
    // youtube.com/watch?v=<id>
    const long = u.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
    if (long?.[1]) return long[1];
    return null;
  }

  _isYouTubeItem(item) {
    if (!item) return false;
    const src = String(item.sourceName || "").toLowerCase();
    if (src.includes("youtube")) return true;
    return YOUTUBE_URL_REGEX.test(String(item.uri || ""));
  }

  async _findAlternativeYouTube(currentItem, take = 6) {
    const title = String(currentItem?.title || "").trim();
    if (!title) return null;

    // Ask Lavalink for multiple YouTube search results and pick a different one.
    const query = `ytsearch:${title}${currentItem?.author ? " " + currentItem.author : ""}`;
    const resolved = await this.resolve(query).catch(() => null);
    if (!resolved?.ok) return null;

    const tracks = (Array.isArray(resolved.tracks) ? resolved.tracks : []).slice(0, take);
    const curId = currentItem.identifier || this._youtubeIdFromUri(currentItem.uri);

    for (const t of tracks) {
      const info = t?.info || {};
      const id = info.identifier || null;
      if (id && this._failedIds.has(id)) continue;
      if (curId && id && id === curId) continue;

      // Keep requester/playlist metadata so the UI stays consistent.
      const alt = this._toItem(t, currentItem.requester, currentItem.playlist || null);
      return alt;
    }

    return null;
  }

  async _handlePlaybackException(e) {
    const msg = this._extractExceptionMessage(e).toLowerCase();
    const cur = this.current;

    if (cur) {
      const curId = cur.identifier || this._youtubeIdFromUri(cur.uri);
      if (curId) this._failedIds.add(curId);

      // If we were using SoundCloud (primary) and it failed, try switching to YouTube
      // (backup nodes) automatically.
      if (SC_TO_YT_FALLBACK && this._isSoundCloudItem(cur)) {
        const shouldSwitch = !this._isPrimaryUp() || String(this.player?.node?.name || "") !== String(PRIMARY_NODE_NAME)
          || /(timeout|abort|closed|reset|unavailable|forbidden|403|404|error|exception|failed)/i.test(msg);

        if (shouldSwitch) {
          const alt = await this._convertToYouTube(cur, 10).catch(() => null);
          if (alt?.encoded) {
            console.warn(`[SC->YT] SoundCloud failed -> trying YouTube result: ${alt.title}`);
            this.current = alt;
            await this._play(alt);
            return;
          }
        }
      }

      // Common YouTube failures on public nodes.
      const yt = this._isYouTubeItem(cur);
      const looksUnavailable =
        yt &&
        /(unavailable|private|copyright|age|restricted|blocked|forbidden|sign in|not available)/i.test(msg);

      if (looksUnavailable) {
        const alt = await this._findAlternativeYouTube(cur, 8).catch(() => null);
        if (alt?.encoded) {
          console.warn(`[YT-FALLBACK] Video unavailable -> trying another result: ${alt.title}`);
          this.current = alt;
          await this._play(alt);
          return;
        }
      }
    }

    // IMPORTANT: do NOT call _handleEnd() here because that may repeat the same
    // broken track when loop=track is enabled. Just move forward.
    await this.playNextIfNeeded(true);
  }


_isPlayerUsable(p) {
  if (!p) return false;
  if (p.destroyed === true) return false;

  const node = p.node;
  const st = node?.state;
  const okNode =
    st === 2 ||
    st === 1 ||
    String(st).toUpperCase() === "CONNECTED" ||
    String(st).toUpperCase() === "NEARLY";
  if (!okNode) return false;

  return true;
}

_makeResumeSnapshot() {
  // Best-effort position tracking (depends on Shoukaku/Lavalink)
  const pos =
    typeof this.player?.position === "number"
      ? this.player.position
      : typeof this.player?.state?.position === "number"
      ? this.player.state.position
      : null;

  return {
    current: this.current ? { ...this.current } : null,
    queue: Array.isArray(this.queue) ? this.queue.map((x) => ({ ...x })) : [],
    paused: Boolean(this.paused),
    position: pos,
    repeatMode: this.repeatMode ?? 0,
    at: Date.now(),
  };
}

markNodeDown(reason = "") {
  if (!this._resumeSnapshot) this._resumeSnapshot = this._makeResumeSnapshot();
  this._nodeDown = true;
  this.player = null;
  this._eventsAttached = false;
  if (reason) console.warn(`[SESSION] Node down (${reason}) for ${this.guildId}/${this.voiceChannelId}`);
  this.onStateChange();
}

async _handlePlayerClosed(e) {
    if (e) console.warn("[SESSION] player closed", e);
  // Sometimes player closes without a node event
  this.markNodeDown("player closed");
  await this.recoverIfNeeded().catch(() => {});
}

async recoverIfNeeded() {
  if (!this._resumeSnapshot) return false;
  if (this._recovering) return await this._recovering;

  const snapshot = this._resumeSnapshot;

  this._recovering = (async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        // Wait for Lavalink ready
        if (typeof this.bot?.waitForNodeReady === "function") {
          const timeout = Number(process.env.LAVALINK_READY_TIMEOUT_MS || "45000");
          await this.bot.waitForNodeReady(timeout).catch(() => false);
        }

        // Backoff to avoid reconnect storms
        await new Promise((r) => setTimeout(r, 800 * attempt));

        await this.ensureConnected();

        // Restore state if needed
        if (!this.current && snapshot.current) this.current = snapshot.current;
        if ((!this.queue || this.queue.length === 0) && snapshot.queue?.length) this.queue = snapshot.queue;
        this.repeatMode = snapshot.repeatMode ?? this.repeatMode;

        if (this.current?.encoded) {
          await this._play(this.current);

          const pos = snapshot.position;
          if (typeof pos === "number" && pos > 0 && typeof this.player?.seekTo === "function") {
            await this.player.seekTo(pos).catch(() => {});
          }

          if (snapshot.paused && typeof this.player?.setPaused === "function") {
            await this.player.setPaused(true).catch(() => {});
            this.paused = true;
          }
        }

        this._resumeSnapshot = null;
        this._nodeDown = false;
        this.onStateChange();
        console.log(`[RECOVER] Session recovered in <#${this.voiceChannelId}>`);
        return true;
      } catch (err) {
        const msg = String(err?.message || err);
        console.warn(`[RECOVER] attempt ${attempt} failed: ${msg}`);
      }
    }

    console.warn("[RECOVER] Unable to recover automatically; try play again or /restart.");
    return false;
  })().finally(() => {
    this._recovering = null;
  });

  return await this._recovering;
}

  _toItem(track, requester, playlistName = null) {
    const info = track?.info || {};
    return {
      encoded: track?.encoded,
      identifier: info.identifier || null,
      title: info.title || "Unknown",
      uri: info.uri || "",
      author: info.author || "",
      length: info.length || 0,
      artworkUrl: info.artworkUrl || null,
      sourceName: info.sourceName || "",
      requester: requester || "unknown",
      playlist: playlistName,
    };
  }

  // Resolve query with Lavalink without modifying the queue.
  // Returns: { ok, type, tracks, playlistName }
  async resolve(query) {
    const raw = String(query ?? "").trim();

    // YouTube is allowed in this build.

    await this.ensureConnected();

    const identifier = this._normalizeIdentifier(raw);
    if (!identifier) return { ok: false, message: "اكتب اسم/رابط." };
    const result = await this.player.node.rest.resolve(identifier).catch(() => null);
    const picked = pickTracksFromResult(result);

    if (!picked || picked.tracks.length === 0) {
      return { ok: false, message: "ما لقيت شي 😅 جرّب رابط مباشر أو اسم أوضح." };
    }

    return {
      ok: true,
      type: picked.type,
      tracks: picked.tracks,
      playlistName: picked.playlistName,
    };
  }

  addTrack(track, requesterTag, playlistName = null) {
    if (!track?.encoded) return { ok: false, message: "Track غير صالح." };
    const item = this._toItem(track, requesterTag, playlistName);
    this.queue.push(item);
    this.onStateChange();
    return { ok: true, added: 1 };
  }

  async add(query, requesterTag, opts = {}) {
    const raw = String(query ?? "").trim();

    // YouTube is allowed in this build.

    const resolved = await this.resolve(raw);
    if (!resolved.ok) return resolved;
    let { type, tracks, playlistName } = resolved;

    // Behavior change:
    // - For search results: add only the first track by default (instead of 10).
    // - For playlists: add all tracks.
    const searchTake = Number.isInteger(opts.searchTake)
      ? Math.max(1, opts.searchTake)
      : 1;

    if (type === "search") {
      tracks = (Array.isArray(tracks) ? tracks : []).slice(0, searchTake);
    }

    if (!tracks || tracks.length === 0) {
      return { ok: false, message: "ما لقيت شي 😅 جرّب رابط مباشر أو اسم أوضح." };
    }

    const addedItems = tracks
      .filter((t) => t?.encoded)
      .map((t) => this._toItem(t, requesterTag, playlistName));
    if (!addedItems.length) return { ok: false, message: "النتيجة رجعت بدون تراك صالح." };

    this.queue.push(...addedItems);
    this.onStateChange();

    return {
      ok: true,
      playlist: type === "playlist",
      added: addedItems.length,
      message: "تمت الإضافة",
    };
  }

  async playNextIfNeeded(force = false) {
    await this.ensureConnected();

    if (!force && this.current && this.player?.track && !this.paused) return;

    if (!force && this.repeatMode === 1 && this.current) {
      const curPlayable = await this._ensurePlayableItem(this.current);
      this.current = curPlayable;
      await this._play(curPlayable);
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      await this.player.stopTrack().catch(() => {});
      this.onStateChange();
      return;
    }

    const nextPlayable = await this._ensurePlayableItem(next);
    this.current = nextPlayable;
    await this._play(nextPlayable);
  }

  async _play(item) {
    if (!item?.encoded) return;

    // If primary is down and this item is SoundCloud, switch it to YouTube automatically.
    const playable = await this._ensurePlayableItem(item);
    if (!playable?.encoded) return;
    item = playable;
    this.current = item;

    this.paused = false;
    try {
  await this.player.playTrack({ track: { encoded: item.encoded } });
} catch (e) {
  const msg = String(e?.message || e);
  console.warn(`[PLAY] playTrack failed (will try recover): ${msg}`);
  this.markNodeDown("playTrack failed");
  await this.recoverIfNeeded().catch(() => {});
  await this.ensureConnected();
  await this.player.playTrack({ track: { encoded: item.encoded } });
}
    if (typeof this.player.setGlobalVolume === "function") {
      await this.player.setGlobalVolume(100).catch(() => {});
    } else if (typeof this.player.setVolume === "function") {
      await this.player.setVolume(100).catch(() => {});
    }
    await this._tryUnsuppressStage().catch(() => {});

    console.log("[PLAY]", { title: item.title, uri: item.uri, guild: this.guildId, voice: this.voiceChannelId });
    this.onStateChange();
  }

  async _handleEnd() {
    // إذا كان فيه طلب رجوع للنود الأساسي (بعد ما يرجع من الانقطاع)،
    // سوّه هنا عشان ما نقطع الصوت mid-track.
    if (this._migrateBackRequested && this._isPrimaryUp() && !this._isOnPrimary()) {
      await this.migrateBackToPrimary({ resume: false }).catch(() => {});
    }

    if (this.repeatMode === 1 && this.current) {
      const curPlayable = await this._ensurePlayableItem(this.current);
      this.current = curPlayable;
      return this._play(curPlayable);
    }
    if (this.repeatMode === 2 && this.current) this.queue.push(this.current);
    await this.playNextIfNeeded(true);
  }

  async skip() {
    if (!this.player) return;
    await this.player.stopTrack().catch(() => {});
    this.onStateChange();
  }

  async stop() {
    this.queue.length = 0;
    this.current = null;
    this.paused = false;
    if (this.player) await this.player.stopTrack().catch(() => {});
    this.onStateChange();
  }

  async togglePause() {
    if (!this.player) return;
    this.paused = !this.paused;
    await this.player.setPaused(this.paused).catch(() => {});
    this.onStateChange();
  }

  cycleLoop() {
    this.repeatMode = (this.repeatMode + 1) % 3;
    this.onStateChange();
    return this.repeatMode;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.onStateChange();
  }

  getStatus() {
    const position =
      (typeof this.player?.position === "number" && this.player.position) ||
      (typeof this.player?.state?.position === "number" && this.player.state.position) ||
      0;

    const nodeName = String(this.player?.node?.name || "");

    const current = this.current
      ? { 
          title: this.current.title, 
          uri: this.current.uri, 
          author: this.current.author, 
          requester: this.current.requester, 
          length: this.current.length, 
          artworkUrl: this.current.artworkUrl 
        }
      : null;

    const upcoming = this.queue.slice(0, 10).map((t) => ({ 
      title: t.title, 
      uri: t.uri, 
      requester: t.requester 
    }));

    return {
      paused: this.paused,
      repeatMode: this.repeatMode,
      nodeName,
      position,
      current,
      upcoming,
      totalQueue: this.queue.length,
    };
  }
}

module.exports = { MusicSession };
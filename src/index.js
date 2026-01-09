try { require("dns").setDefaultResultOrder("ipv4first"); } catch {}
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

const { BotPool } = require("./pool");
const { MusicSession } = require("./session");
const { buildGlobalPanel, buildRoomPanel } = require("./panel");

const EPHEMERAL = 64; // MessageFlags.Ephemeral

// ===== Config =====
const CONFIG_PATH = path.join(process.cwd(), "config.json");
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

    // Migration: قديم كان فيه homeVoiceChannelId
    if (!cfg.rooms && cfg.homeVoiceChannelId) {
      cfg.rooms = [{ voiceChannelId: String(cfg.homeVoiceChannelId) }];
    }

    return {
      controlTextChannelId: cfg.controlTextChannelId ?? null,
      panelMessageId: cfg.panelMessageId ?? null,
      cleanControlChannel: cfg.cleanControlChannel !== false,
      keep24_7: Boolean(cfg.keep24_7),

      // UI (optional)
      panelBannerUrl: cfg.panelBannerUrl ?? null,
      emojis: {
        // defaults يمكن تغييرها من config.json
        refresh: cfg?.emojis?.refresh || { id: "1449445887532072991", name: "icons_refresh" },
        myRoomPanel: cfg?.emojis?.myRoomPanel || { id: "1449446233935450244", name: "MekoServer" },
        // أيقونة عنوان اللوحات (اختياري)
        // لو حاب تستخدم إيموجي مخصص بدل 🎵
        musicNote: cfg?.emojis?.musicNote || { id: "1452378261878472999", name: "Volume" },
      },

      // new
      restrictToRooms: cfg.restrictToRooms !== false, // default true
      restrictCommandsToControlChannel: cfg.restrictCommandsToControlChannel !== false, // default true
      rooms: Array.isArray(cfg.rooms) ? cfg.rooms : [],
    };
  } catch {
    return {
      controlTextChannelId: null,
      panelMessageId: null,
      cleanControlChannel: true,
      keep24_7: false,

      panelBannerUrl: null,

      emojis: {
        refresh: { id: "1449445887532072991", name: "icons_refresh" },
        myRoomPanel: { id: "1449446233935450244", name: "MekoServer" },
        musicNote: { id: "1452378261878472999", name: "Volume" },
      },

      restrictToRooms: true,
      restrictCommandsToControlChannel: true,
      rooms: [],
    };
  }
}

function resolveEmojiForGuild(guild, emojiCfg) {
  if (!emojiCfg || !emojiCfg.id) return null;
  const id = String(emojiCfg.id);
  const fromGuild = guild?.emojis?.cache?.get(id) || null;
  const name = fromGuild?.name || (emojiCfg.name ? String(emojiCfg.name).replace(/:/g, "") : "emoji");

  // If the bot can't actually see this emoji in the target guild, don't force it.
  // We'll fall back to a Unicode emoji so the panel looks clean.
  if (!fromGuild) {
    // warn once per emoji id (avoid log spam)
    resolveEmojiForGuild._warned ??= new Set();
    if (!resolveEmojiForGuild._warned.has(id)) {
      resolveEmojiForGuild._warned.add(id);
      console.warn(`[EMOJI] Emoji not found in this guild: id=${id} name=${name} — falling back.`);
    }
    return null;
  }

  return { id, name, tag: fromGuild.toString() };
}

function resolveEmojisForGuild(guild, emojisCfg) {
  return {
    refresh: resolveEmojiForGuild(guild, emojisCfg?.refresh),
    myRoomPanel: resolveEmojiForGuild(guild, emojisCfg?.myRoomPanel),
    musicNote: resolveEmojiForGuild(guild, emojisCfg?.musicNote),
  };
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const cfg = readConfig();

// ===== Env =====
const hasMultiNodeEnv = Object.keys(process.env).some((k) => /^LAVALINK_URL_\d+$/.test(k) && process.env[k]);
const hasAnyNodeEnv = !!process.env.LAVALINK_URL || hasMultiNodeEnv || !!process.env.LAVALINK_NODES || !!process.env.LAVALINK_NODES_JSON;
const disableLavalink = String(process.env.DISABLE_LAVALINK || "") === "1" || !hasAnyNodeEnv;
const managerToken = (process.env.MANAGER_TOKEN || "").trim();
// WORKER_TOKENS ممكن تكون طويلة جداً؛ وبعض الاستضافات/المحررات يضيفون أسطر جديدة.
// لذلك ندعم أيضاً WORKER_TOKENS_1, WORKER_TOKENS_2 ... لتقسيم التوكنات.
const workerTokenParts = [];
if (process.env.WORKER_TOKENS) workerTokenParts.push(String(process.env.WORKER_TOKENS));

Object.keys(process.env)
  .filter((k) => /^WORKER_TOKENS_\d+$/.test(k))
  .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
  .forEach((k) => {
    const v = process.env[k];
    if (v) workerTokenParts.push(String(v));
  });

const workerTokens = workerTokenParts
  .join(",")
  .split(/[\n\r,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

// ===== Text commands (message commands) =====
// Enable in .env: TEXT_COMMANDS=1
// Optional:
//   MESSAGE_PREFIX=!            (prefix commands: !play, !pause, ...)
//   TEXT_COMMANDS_NO_PREFIX=1   (allow Arabic keywords without prefix inside control channel)
//   BOT_REPLY_DELETE_MS=12000   (auto delete bot replies in control channel)
const TEXT_COMMANDS_ENABLED = String(process.env.TEXT_COMMANDS || "1") === "1";
const MESSAGE_PREFIX = String(process.env.MESSAGE_PREFIX || "!").trim();
const TEXT_COMMANDS_NO_PREFIX = String(process.env.TEXT_COMMANDS_NO_PREFIX || "1") === "1";
const BOT_REPLY_DELETE_MS = Number(
  process.env.BOT_REPLY_DELETE_MS || (cfg.cleanControlChannel ? "12000" : "0")
);

// ===== Panel auto refresh (optional) =====
// Set PANEL_AUTO_REFRESH_SEC=0 to disable. Default: 20 seconds.
const PANEL_AUTO_REFRESH_SEC = Number(process.env.PANEL_AUTO_REFRESH_SEC || "20");
// Delay between joining configured rooms (24/7) to reduce rate-limits/lag
const ROOM_JOIN_DELAY_MS = Number(process.env.ROOM_JOIN_DELAY_MS || "800");

// Auto-migrate sessions back to the primary Lavalink node when it reconnects
const PRIMARY_NODE_NAME =
  process.env.LAVALINK_PRIMARY_NAME ||
  process.env.PRIMARY_NODE_NAME ||
  process.env.LAVALINK_NAME_1 ||
  "main";
const AUTO_MIGRATE_BACK_TO_PRIMARY = String(process.env.AUTO_MIGRATE_BACK_TO_PRIMARY || "0") === "1";
const AUTO_MIGRATE_BACK_STAGGER_MS = Number(process.env.AUTO_MIGRATE_BACK_STAGGER_MS || "700");

console.log(`🧩 Loaded ${workerTokens.length} worker token(s) from ${workerTokenParts.length} env part(s).`);
const weirdEnvKeys = Object.keys(process.env).filter((k) => k.startsWith(','));
if (weirdEnvKeys.length) {
  console.warn('⚠️ Looks like your WORKER_TOKENS broke into multiple lines in .env. Use WORKER_TOKENS_1/2/3... (one line each).');
}

if (!managerToken) {
  console.error("❌ حط MANAGER_TOKEN في .env");
  process.exit(1);
}

if (!disableLavalink && workerTokens.length === 0) {
  console.error("❌ لازم تحط WORKER_TOKENS (بوت واحد على الأقل) — البوت المدير ما يدخل فويس.");
  process.exit(1);
}

function parseLavalinkNodesFromEnv() {
  const parseBool = (v) => String(v).toLowerCase() === "true" || String(v) === "1";
  const nodes = [];

  // 1) JSON format: LAVALINK_NODES_JSON='[{"name":"node1","url":"host:port","auth":"pass","secure":true}, ...]'
  if (process.env.LAVALINK_NODES_JSON) {
    try {
      const arr = JSON.parse(process.env.LAVALINK_NODES_JSON);
      if (Array.isArray(arr)) {
        for (const n of arr) {
          const url = n?.url || (n?.host && n?.port ? `${n.host}:${n.port}` : null);
          const auth = n?.auth || n?.password;
          if (!url || !auth) continue;
          nodes.push({
            name: n?.name || `node${nodes.length + 1}`,
            url,
            auth,
            secure: n?.secure === true,
            retryAmount: Number(n?.retryAmount || 5),
            retryDelay: Number(n?.retryDelay || 5000),
          });
        }
      }
    } catch {
      console.warn("⚠️ LAVALINK_NODES_JSON غير صالح (JSON). تجاهلناه.");
    }
  }

  // 2) Numbered env vars: LAVALINK_URL_1 / LAVALINK_PASSWORD_1 / LAVALINK_SECURE_1 ...
  for (let i = 1; i <= 20; i++) {
    const url = process.env[`LAVALINK_URL_${i}`];
    if (!url) continue;
    const auth = process.env[`LAVALINK_PASSWORD_${i}`] || process.env[`LAVALINK_AUTH_${i}`];
    if (!auth) continue;
    nodes.push({
      name: process.env[`LAVALINK_NAME_${i}`] || `node${i}`,
      url,
      auth,
      secure: parseBool(process.env[`LAVALINK_SECURE_${i}`]),
      retryAmount: 5,
      retryDelay: 5000,
    });
  }

  // 3) Simple list: LAVALINK_NODES="name@host:port@pass@secure;name2@host:port@pass@secure"
  if (process.env.LAVALINK_NODES) {
    const parts = String(process.env.LAVALINK_NODES)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const [name, url, auth, secure] = p.split("@");
      if (!url || !auth) continue;
      nodes.push({
        name: name || `node${nodes.length + 1}`,
        url,
        auth,
        secure: parseBool(secure),
        retryAmount: 5,
        retryDelay: 5000,
      });
    }
  }

  // 4) Fallback single node env
  if (nodes.length === 0 && process.env.LAVALINK_URL) {
    nodes.push({
      name: process.env.LAVALINK_NAME || "main",
      url: process.env.LAVALINK_URL,
      auth: process.env.LAVALINK_PASSWORD || process.env.LAVALINK_AUTH || "youshallnotpass",
      secure: parseBool(process.env.LAVALINK_SECURE),
      retryAmount: 5,
      retryDelay: 5000,
    });
  }

  // Remove duplicates by name+url
  const seen = new Set();
  return nodes.filter((n) => {
    const key = `${n.name}|${n.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const lavalinkNodes = disableLavalink ? [] : parseLavalinkNodesFromEnv();

if (!disableLavalink && lavalinkNodes.length === 0) {
  console.error("❌ Lavalink مفعل لكن ما لقينا أي Nodes صالحة. حط LAVALINK_URL أو LAVALINK_URL_1/2/3... أو LAVALINK_NODES_JSON");
  process.exit(1);
}

if (!disableLavalink) {
  const nodesDesc = lavalinkNodes
    .map((n) => `${n.name}=${n.url}${n.secure ? " (wss)" : " (ws)"}`)
    .join(" | ");
  console.log(`🎧 Lavalink nodes: ${nodesDesc}`);
}

// ===== Pool =====
const pool = new BotPool({
  managerToken,
  workerTokens,
  lavalinkNodes,
  disableLavalink,
});

// ===== Sessions =====
const sessions = new Map(); // key: guildId:voiceChannelId -> MusicSession

// ===== Panel diff / log throttling =====
let _lastPanelSignature = null; // legacy
let _lastPanelDataSignature = null;
let _lastPanelUpdatedUnix = null;
let _lastPanelLogAt = 0;
const PANEL_LOG_EVERY_MS = Number(process.env.PANEL_LOG_EVERY_SEC || "0") * 1000;

// ===== Global panel update throttle (to reduce lag / rate limits) =====
let _globalUpdateTimer = null;
let _globalUpdateRunning = false;
let _globalUpdateQueued = false;

function scheduleGlobalPanelUpdate(delayMs = 650) {
  if (_globalUpdateTimer) return;
  _globalUpdateTimer = setTimeout(async () => {
    _globalUpdateTimer = null;

    if (_globalUpdateRunning) {
      _globalUpdateQueued = true;
      return;
    }

    _globalUpdateRunning = true;
    try {
      await updateGlobalPanel();
    } catch {
      // ignore
    } finally {
      _globalUpdateRunning = false;
      if (_globalUpdateQueued) {
        _globalUpdateQueued = false;
        scheduleGlobalPanelUpdate(250);
      }
    }
  }, delayMs);
}

// ===== Search picker cache (for /search select menu) =====
const searchCache = new Map(); // id -> { createdAt, guildId, voiceChannelId, userId, tracks }
function makeId(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function putSearchCache(entry) {
  const id = makeId(10);
  searchCache.set(id, { ...entry, createdAt: Date.now() });
  return id;
}

function getSearchCache(id) {
  const e = searchCache.get(id);
  if (!e) return null;
  if (Date.now() - e.createdAt > 5 * 60 * 1000) {
    searchCache.delete(id);
    return null;
  }
  return e;
}
function key(guildId, voiceChannelId) {
  return `${guildId}:${voiceChannelId}`;
}

function getRoomEntry(voiceChannelId) {
  const id = String(voiceChannelId);
  return (cfg.rooms || []).find((r) => String(r?.voiceChannelId) === id) || null;
}

function isRoomAllowed(voiceChannelId) {
  if (!cfg.restrictToRooms) return true;
  return Boolean(getRoomEntry(voiceChannelId));
}

function getPreferredBotIndex(voiceChannelId) {
  const r = getRoomEntry(voiceChannelId);
  if (!r) return null;
  const b = Number(r.bot);
  return Number.isInteger(b) ? b : null; // 1..N (worker slot)
}

function countConnectedWorkers() {
  return pool.bots
    .slice(1)
    .filter((b) => (typeof b.hasConnectedNode === "function" ? b.hasConnectedNode() : false)).length;
}

function isOffline() {
  if (disableLavalink) return true;
  return countConnectedWorkers() === 0;
}

async function getOrCreateSession({ guildId, voiceChannelId, textChannelId }) {
  if (disableLavalink) return { ok: false, message: "Lavalink disabled" };

  if (!isRoomAllowed(voiceChannelId)) {
    return {
      ok: false,
      message: "❌ هذا الروم مو مضاف ضمن rooms في config.json.\nاستخدم /rooms عشان تشوف الرومات المسموحة.",
    };
  }

  const k = key(guildId, voiceChannelId);
  if (sessions.has(k)) return { ok: true, session: sessions.get(k) };

  // حاول نلتزم بالـ bot المحدد (لو موجود)
  const preferred = getPreferredBotIndex(voiceChannelId);
  let idx = pool.getAssignedBotIndex(guildId, voiceChannelId);

  if (idx === null && preferred) {
    idx = pool.allocateSpecific(guildId, voiceChannelId, preferred);
    if (idx === null) {
      return {
        ok: false,
        message: `❌ البوت رقم ${preferred} مشغول في روم ثاني.\nغيّر التوزيع (rooms) أو زوّد عدد البوتات.`,
      };
    }
  }

  if (idx === null) {
    idx = pool.getOrAllocateBot(guildId, voiceChannelId);
  }

  if (idx === null) {
    return {
      ok: false,
      message: "❌ ما فيه بوتات فاضية حالياً. زوّد WORKER_TOKENS أو قلّل عدد الرومات.",
    };
  }

  const bot = pool.bots[idx];
  if (!bot?.shoukaku) {
    return { ok: false, message: "❌ هذا البوت ما عنده Lavalink/Shoukaku." };
  }

  const session = new MusicSession({
    guildId,
    voiceChannelId,
    textChannelId,
    bot,
    onStateChange: () => scheduleGlobalPanelUpdate(),
  });

  try {
    await session.ensureConnected();
    sessions.set(k, session);
    return { ok: true, session };
  } catch (e) {
    sessions.delete(k);
    return { ok: false, message: `❌ فشل الاتصال بالروم/Lavalink: ${e?.message || e}` };
  }
}

async function getVoiceChannelName(managerClient, voiceChannelId) {
  try {
    const ch = await managerClient.channels.fetch(voiceChannelId);
    return ch?.name || null;
  } catch {
    return null;
  }
}

async function updateGlobalPanel() {
  const manager = pool.manager.client;
  if (!cfg.controlTextChannelId) return;

  const channel = await manager.channels.fetch(cfg.controlTextChannelId).catch(() => null);
  if (!channel) return;

  const guildId = channel.guildId;
  const roomIds = (cfg.rooms || [])
    .map((r) => String(r?.voiceChannelId || ""))
    .filter(Boolean);

  // لو ما فيه rooms في config، نعرض الرومات اللي عليها Sessions نشطة
  const idsToRender = roomIds.length
    ? [...new Set(roomIds)]
    : [...new Set([...sessions.keys()].filter((k) => k.startsWith(`${guildId}:`)).map((k) => k.split(":")[1]))];

  const rooms = idsToRender.map((voiceId) => {
    const s = sessions.get(key(guildId, voiceId));
    if (!s) {
      return { voiceChannelId: voiceId, state: "idle", queue: 0 };
    }
    const st = s.getStatus();
    const state = st.current ? (st.paused ? "paused" : "playing") : "idle";
    return { voiceChannelId: voiceId, state, queue: st.totalQueue || 0 };
  });

  const connected = countConnectedWorkers();
  const total = Math.max(pool.bots.length - 1, 0);
  const botsSummary = disableLavalink
    ? "DISABLED"
    : `${connected}/${total} connected`;

  const guild = channel.guild || (guildId ? await manager.guilds.fetch(guildId).catch(() => null) : null);
  const resolvedEmojis = resolveEmojisForGuild(guild, cfg.emojis);

  // Brand assets (banner/icon)
  const botIcon = manager.user?.displayAvatarURL({ size: 256 }) || null;
  const guildBanner = guild?.bannerURL?.({ size: 1024 }) || null;
  const guildIcon = guild?.iconURL?.({ size: 256 }) || null;
  const bannerURL =
    cfg.panelBannerUrl ||
    process.env.PANEL_BANNER_URL ||
    guildBanner ||
    botIcon ||
    guildIcon ||
    null;

  const brand = {
    name: manager.user?.username || "Oasis Music",
    iconURL: botIcon || guildIcon || undefined,
    bannerURL: bannerURL || undefined,
  };

  const offlineNow = isOffline();
  const dataSignature = JSON.stringify({ offlineNow, rooms, botsSummary });
  if (_lastPanelDataSignature === dataSignature) return;
  _lastPanelDataSignature = dataSignature;
  _lastPanelUpdatedUnix = Math.floor(Date.now() / 1000);

  const payload = buildGlobalPanel({
    offline: offlineNow,
    rooms,
    botsSummary,
    emojis: resolvedEmojis,
    brand,
    autoRefreshSec: PANEL_AUTO_REFRESH_SEC,
    updatedUnix: _lastPanelUpdatedUnix,
  });

  if (cfg.panelMessageId) {
    const msg = await channel.messages.fetch(cfg.panelMessageId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      if (PANEL_LOG_EVERY_MS > 0) {
        const now = Date.now();
        if (now - _lastPanelLogAt >= PANEL_LOG_EVERY_MS) {
          _lastPanelLogAt = now;
          console.log(`[PANEL] Updated existing panel message (${cfg.panelMessageId})`);
        }
      }
      return;
    }
  }

  const newMsg = await channel.send(payload);
  cfg.panelMessageId = newMsg.id;
  if (PANEL_LOG_EVERY_MS > 0) {
    const now = Date.now();
    if (now - _lastPanelLogAt >= PANEL_LOG_EVERY_MS) {
      _lastPanelLogAt = now;
      console.log(`[PANEL] Sent new panel message (${cfg.panelMessageId})`);
    }
  }
  writeConfig(cfg);
}

function replyMaintenance(interaction) {
  return interaction.reply({
    content: "⚠️ Lavalink غير متصل. تأكد من تشغيل Lavalink وإعدادات .env.",
    flags: EPHEMERAL,
  });
}

// ===== Slash Commands deploy =====
async function autoDeployCommands(managerClient) {
  const clientId = (process.env.CLIENT_ID || "").trim();
  const guildId = (process.env.GUILD_ID || "").trim();
  if (!clientId || !guildId) {
    console.warn("⚠️ ناقص CLIENT_ID أو GUILD_ID — ما راح تتسجل أوامر السلاش.");
    return;
  }

  const playCmd = (name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription("تشغيل/إضافة أغنية أو بلايليست (على رومك الصوتي)")
      .addStringOption((o) => o.setName("query").setDescription("اسم/رابط").setRequired(true));

  const searchCmd = () =>
    new SlashCommandBuilder()
      .setName("search")
      .setDescription("بحث واختيار نتيجة قبل الإضافة (على رومك الصوتي)")
      .addStringOption((o) => o.setName("query").setDescription("اسم").setRequired(true));

  const commands = [
    playCmd("play"),
    playCmd("p"),
    searchCmd(),
    new SlashCommandBuilder().setName("skip").setDescription("تخطي (على رومك الصوتي)"),
    new SlashCommandBuilder().setName("pause").setDescription("إيقاف مؤقت (على رومك الصوتي)"),
    new SlashCommandBuilder().setName("resume").setDescription("تكملة (على رومك الصوتي)"),
    new SlashCommandBuilder().setName("stop").setDescription("إيقاف ومسح الكيو (على رومك الصوتي)"),
    new SlashCommandBuilder().setName("queue").setDescription("عرض الكيو (على رومك الصوتي)"),

    new SlashCommandBuilder().setName("panel").setDescription("إنشاء/تحديث اللوحة العامة"),
    new SlashCommandBuilder().setName("rooms").setDescription("عرض الرومات المضافة وتوزيع البوتات"),

    new SlashCommandBuilder()
      .setName("bind")
      .setDescription("ربط روم صوتي ببوت رقم (Worker)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) =>
        o
          .setName("room")
          .setDescription("الروم الصوتي")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true)
      )
      .addIntegerOption((o) =>
        o
          .setName("bot")
          .setDescription("رقم البوت (1 = أول Worker Token)")
          .setMinValue(1)
          .setMaxValue(25)
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("unbind")
      .setDescription("فك الربط/حذف روم من القائمة")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) =>
        o
          .setName("room")
          .setDescription("الروم الصوتي")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true)
      ),

    new SlashCommandBuilder().setName("debug").setDescription("معلومات تشخيصية عن Lavalink والبوتات"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.MANAGER_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ Slash commands deployed");
  } catch (err) {
    console.error("❌ Slash deploy failed:", err?.rawError?.message || err.message);
  }
}

// ===== Main =====
async function main() {
  const manager = pool.manager.client;

  manager.on("error", (e) => console.error("[Client error]", e));
  process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
  process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

  manager.once("ready", async () => {
    console.log(`✅ Manager logged in as ${manager.user.tag}`);
    await autoDeployCommands(manager);
    await updateGlobalPanel();

    // Auto refresh the global panel periodically (optional)
    if (PANEL_AUTO_REFRESH_SEC > 0) {
      setInterval(() => {
        try { scheduleGlobalPanelUpdate(0); } catch {}
      }, PANEL_AUTO_REFRESH_SEC * 1000);
      console.log(`[PANEL] Auto refresh every ${PANEL_AUTO_REFRESH_SEC}s enabled.`);
    }

    // 24/7 join moved to after workers startup (see bottom of main)

  });

  // تنظيف روم التحكم (اختياري)
  manager.on("messageCreate", async (msg) => {
    try {
      if (!msg?.guildId) return;
      if (msg.author?.bot) return;

      const inControl = cfg.controlTextChannelId ? msg.channelId === cfg.controlTextChannelId : true;
      const mustUseControl = cfg.controlTextChannelId && cfg.restrictCommandsToControlChannel;

      // Helper: send a short reply (and optionally delete it)
      const replyTemp = async (content) => {
        const sent = await msg.channel.send({ content }).catch(() => null);
        if (sent && BOT_REPLY_DELETE_MS > 0 && inControl) {
          setTimeout(() => sent.delete().catch(() => {}), BOT_REPLY_DELETE_MS);
        }
        return sent;
      };

      const raw = String(msg.content || "").trim();

      // 1) Try text commands
      let handled = false;
      if (TEXT_COMMANDS_ENABLED && raw) {
        let body = raw;
        let usedPrefix = false;

        if (MESSAGE_PREFIX && body.startsWith(MESSAGE_PREFIX)) {
          body = body.slice(MESSAGE_PREFIX.length).trim();
          usedPrefix = true;
        }

        // If no prefix used, only allow when configured, and best inside control channel to avoid accidents.
        if (usedPrefix || (TEXT_COMMANDS_NO_PREFIX && inControl)) {
          const [first, ...restParts] = body.split(/\s+/).filter(Boolean);
          const cmdWord = (first || "").toLowerCase();
          const rest = restParts.join(" ").trim();

          const aliases = {
            // Play
            "play": "play",
            "p": "play",
            "شغل": "play",
            "تشغيل": "play",

            // Pause
            "pause": "pause",
            "وقف": "pause",
            "ايقاف": "pause",
            "إيقاف": "pause",

            // Resume
            "resume": "resume",
            "كمل": "resume",
            "استئناف": "resume",

            // Stop
            "stop": "stop",
            "توقف": "stop",
            "ستوب": "stop",

            // Skip
            "skip": "skip",
            "next": "skip",
            "تخطي": "skip",
            "التالي": "skip",

            // Queue
            "queue": "queue",
            "q": "queue",
            "قائمة": "queue",
            "كيو": "queue",

            // Help
            "help": "help",
            "مساعدة": "help",
          };

          const action = aliases[cmdWord] || null;

          if (action) {
            // respect control-channel restriction
            if (mustUseControl && !inControl) {
              handled = true;
              await replyTemp("استخدم الأوامر في روم التحكم فقط ✅");
            } else if (disableLavalink) {
              handled = true;
              await replyTemp("⚠️ Lavalink متعطل.");
            } else {
              handled = true;

              if (action === "help") {
                await replyTemp(
                  "**أوامر الكتابة:**\n" +
                    `• ${MESSAGE_PREFIX}play <اسم/رابط>  |  شغل <اسم/رابط>\n` +
                    `• ${MESSAGE_PREFIX}pause  |  وقف\n` +
                    `• ${MESSAGE_PREFIX}resume |  كمل\n` +
                    `• ${MESSAGE_PREFIX}stop   |  توقف\n` +
                    `• ${MESSAGE_PREFIX}skip   |  التالي\n` +
                    `• ${MESSAGE_PREFIX}queue  |  قائمة\n` +
                    "\nملاحظة: لازم تكون داخل نفس الروم الصوتي." 
                );
              } else {
                const voiceId = msg.member?.voice?.channelId || null;
                if (!voiceId) {
                  await replyTemp("ادخل روم صوتي أول ✅");
                } else if (!isRoomAllowed(voiceId)) {
                  await replyTemp("هذا الروم مو مضاف ضمن rooms. استخدم /rooms.");
                } else {
                  if (action === "play") {
                    if (!rest) {
                      await replyTemp(`اكتب: **شغل <اسم/رابط>** أو **${MESSAGE_PREFIX}play <اسم/رابط>**`);
                    } else {
                      const res = await getOrCreateSession({
                        guildId: msg.guildId,
                        voiceChannelId: voiceId,
                        textChannelId: cfg.controlTextChannelId || msg.channelId,
                      });
                      if (!res.ok) {
                        await replyTemp(res.message || "❌ فشل");
                      } else {
                        const session = res.session;
                        const addRes = await session.add(rest, msg.author.tag);
                        if (!addRes.ok) {
                          await replyTemp(addRes.message || "❌");
                        } else {
                          await session.playNextIfNeeded();
                          scheduleGlobalPanelUpdate();
                          await replyTemp(addRes.playlist ? `✅ تم إضافة بلايليست (${addRes.added})` : `✅ تمت الإضافة (${addRes.added})`);
                        }
                      }
                    }
                  } else {
                    const s = sessions.get(key(msg.guildId, voiceId));
                    if (!s) {
                      await replyTemp("ما فيه جلسة شغالة للروم هذا حالياً.");
                    } else {
                      if (action === "skip") {
                        await s.skip();
                        scheduleGlobalPanelUpdate();
                        await replyTemp("⏭️");
                      }
                      if (action === "pause") {
                        if (!s.paused) await s.togglePause();
                        scheduleGlobalPanelUpdate();
                        await replyTemp("⏸️");
                      }
                      if (action === "resume") {
                        if (s.paused) await s.togglePause();
                        scheduleGlobalPanelUpdate();
                        await replyTemp("▶️");
                      }
                      if (action === "stop") {
                        await s.stop();
                        scheduleGlobalPanelUpdate();
                        await replyTemp("🛑");
                      }
                      if (action === "queue") {
                        const st = s.getStatus();
                        const lines = st.upcoming.map((t, i) => `${i + 1}) ${t.title} — ${t.requester}`).join("\n") || "—";
                        await replyTemp(`**Up Next**\n${lines}`);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } else if (TEXT_COMMANDS_ENABLED && inControl && !raw) {
        // If message content intent is missing, content may come empty.
        // Don't spam logs, just ignore.
      }

      // 2) Optional cleanup: delete user messages in control channel (including command messages)
      if (cfg.cleanControlChannel && cfg.controlTextChannelId && inControl) {
        // delete after a short delay so other listeners (if any) can read it
        setTimeout(() => msg.delete().catch(() => {}), handled ? 500 : 150);
      }
    } catch (e) {
      console.error("[TextCmd Error]", e);
    }
  });

  // ===== Interactions =====
  manager.on("interactionCreate", async (interaction) => {
    try {
      const inControl = cfg.controlTextChannelId ? interaction.channelId === cfg.controlTextChannelId : true;
      const mustUseControl = cfg.controlTextChannelId && cfg.restrictCommandsToControlChannel;

      // ===== Buttons =====
      if (interaction.isButton()) {
        const id = String(interaction.customId || "");

        // Global panel buttons
        if (id === "refresh_global_panel") {
          await interaction.deferUpdate().catch(() => {});
          await updateGlobalPanel();
          return;
        }

        if (id === "open_room_panel") {
          if (disableLavalink) {
            return interaction.reply({ content: "⚠️ Lavalink متعطل.", flags: EPHEMERAL });
          }

          const voiceId = interaction.member?.voice?.channelId || null;
          if (!voiceId) {
            return interaction.reply({ content: "ادخل روم صوتي أول ✅", flags: EPHEMERAL });
          }
          if (!isRoomAllowed(voiceId)) {
            return interaction.reply({ content: "هذا الروم مو مضاف ضمن rooms. استخدم /rooms.", flags: EPHEMERAL });
          }

          await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});
          const res = await getOrCreateSession({
            guildId: interaction.guildId,
            voiceChannelId: voiceId,
            textChannelId: cfg.controlTextChannelId || interaction.channelId,
          });

          if (!res.ok) return interaction.editReply({ content: res.message || "❌ فشل" });

          const status = { ...res.session.getStatus(), offline: isOffline() };
          const roomName = await getVoiceChannelName(manager, voiceId);
          const guild = interaction.guild || (interaction.guildId ? await manager.guilds.fetch(interaction.guildId).catch(() => null) : null);
          const resolvedEmojis = resolveEmojisForGuild(guild, cfg.emojis);

          const botIcon = manager.user?.displayAvatarURL({ size: 256 }) || null;
          const guildBanner = guild?.bannerURL?.({ size: 1024 }) || null;
          const guildIcon = guild?.iconURL?.({ size: 256 }) || null;
          const bannerURL = cfg.panelBannerUrl || process.env.PANEL_BANNER_URL || guildBanner || botIcon || guildIcon || null;
          const brand = {
            name: manager.user?.username || "Oasis Music",
            iconURL: botIcon || guildIcon || undefined,
            bannerURL: bannerURL || undefined,
          };

          const payload = buildRoomPanel({ voiceChannelId: voiceId, status, roomName, emojis: resolvedEmojis, brand });
          await interaction.editReply(payload);
          return;
        }

        // Room panel buttons (music_*:VOICE)
        if (id.startsWith("music_") && id.includes(":")) {
          if (disableLavalink) {
            return interaction.reply({ content: "⚠️ Lavalink متعطل.", flags: EPHEMERAL });
          }
          const [action, voiceId] = id.split(":");
          if (!voiceId) return;

          // لازم يكون داخل نفس الروم
          const userVoice = interaction.member?.voice?.channelId || null;
          if (!userVoice || String(userVoice) !== String(voiceId)) {
            return interaction.reply({
              content: "لازم تكون داخل نفس الروم الصوتي عشان تتحكم ✅",
              flags: EPHEMERAL,
            });
          }

          const s = sessions.get(key(interaction.guildId, voiceId));
          if (!s) {
            return interaction.reply({ content: "ما فيه جلسة شغالة للروم هذا.", flags: EPHEMERAL });
          }

          // نفذ الأمر
          if (action === "music_toggle") await s.togglePause();
          else if (action === "music_skip") await s.skip();
          else if (action === "music_stop") await s.stop();
          else if (action === "music_loop") s.cycleLoop();
          else if (action === "music_shuffle") s.shuffle();

          // تحديث اللوحة الخاصة
          const status = { ...s.getStatus(), offline: isOffline() };
          const roomName = await getVoiceChannelName(manager, voiceId);
          const guild = interaction.guild || (interaction.guildId ? await manager.guilds.fetch(interaction.guildId).catch(() => null) : null);
          const resolvedEmojis = resolveEmojisForGuild(guild, cfg.emojis);

          const botIcon = manager.user?.displayAvatarURL({ size: 256 }) || null;
          const guildBanner = guild?.bannerURL?.({ size: 1024 }) || null;
          const guildIcon = guild?.iconURL?.({ size: 256 }) || null;
          const bannerURL = cfg.panelBannerUrl || process.env.PANEL_BANNER_URL || guildBanner || botIcon || guildIcon || null;
          const brand = {
            name: manager.user?.username || "Oasis Music",
            iconURL: botIcon || guildIcon || undefined,
            bannerURL: bannerURL || undefined,
          };

          const payload = buildRoomPanel({ voiceChannelId: voiceId, status, roomName, emojis: resolvedEmojis, brand });

          if (action === "music_queue") {
            const st = s.getStatus();
            const lines = st.upcoming.map((t, i) => `${i + 1}) ${t.title} — ${t.requester}`).join("\n") || "—";
            await interaction.update(payload).catch(() => {});
            await interaction.followUp({ content: `**Up Next**\n${lines}`, flags: EPHEMERAL }).catch(() => {});
          } else {
            await interaction.update(payload).catch(() => {});
          }

          scheduleGlobalPanelUpdate();
          return;
        }

        // أي زر ثاني
        return;
      }

      // ===== Select Menus (Search picker) =====
      if (interaction.isStringSelectMenu()) {
        const id = String(interaction.customId || "");
        if (!id.startsWith("search_pick:")) return;

        const cacheId = id.split(":")[1] || null;
        const entry = cacheId ? getSearchCache(cacheId) : null;
        if (!entry) {
          return interaction.reply({ content: "انتهت مدة الاختيار 😅...", flags: EPHEMERAL });
        }

        if (String(entry.userId) !== String(interaction.user.id)) {
          return interaction.reply({ content: "هذا الاختيار مو لك ❌", flags: EPHEMERAL });
        }
        if (String(entry.guildId) !== String(interaction.guildId)) {
          return interaction.reply({ content: "سيرفر مختلف ❌", flags: EPHEMERAL });
        }

        const userVoice = interaction.member?.voice?.channelId || null;
        if (!userVoice || String(userVoice) !== String(entry.voiceChannelId)) {
          return interaction.reply({ content: "لازم تكون داخل نفس الروم الصوتي عشان تضيف ✅", flags: EPHEMERAL });
        }

        const pickedIndex = Number(interaction.values?.[0]);
        const track = Array.isArray(entry.tracks) ? entry.tracks[pickedIndex] : null;
        if (!track) {
          return interaction.reply({ content: "اختيار غير صالح", flags: EPHEMERAL });
        }

        // Ensure session exists
        const res = await getOrCreateSession({
          guildId: entry.guildId,
          voiceChannelId: entry.voiceChannelId,
          textChannelId: cfg.controlTextChannelId || interaction.channelId,
        });
        if (!res.ok) {
          return interaction.reply({ content: res.message || "❌ فشل", flags: EPHEMERAL });
        }

        const session = res.session;
        const addRes = session.addTrack(track, interaction.user.tag);
        if (!addRes.ok) {
          return interaction.reply({ content: addRes.message || "❌", flags: EPHEMERAL });
        }

        await session.playNextIfNeeded();
        scheduleGlobalPanelUpdate();

        const title = track?.info?.title || "Unknown";
        const embed = new EmbedBuilder()
          .setTitle("✅ تمت الإضافة")
          .setDescription(`${title}${track?.info?.uri ? `\n<${track.info.uri}>` : ""}`);

        searchCache.delete(cacheId);

        return interaction.update({ embeds: [embed], components: [] }).catch(() => {
          // fallback if update fails
          return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
        });
      }

      // ===== Slash Commands =====
      if (interaction.isChatInputCommand()) {
        const cmd = interaction.commandName;

        if (cmd === "debug") {
          const connected = countConnectedWorkers();
          const total = Math.max(pool.bots.length - 1, 0);
          const lavalinkStatus = disableLavalink ? "DISABLED" : connected > 0 ? "CONNECTED" : "DISCONNECTED";

          const embed = new EmbedBuilder()
            .setTitle("🔧 Debug")
            .setColor(lavalinkStatus === "CONNECTED" ? 0x00ff00 : lavalinkStatus === "DISABLED" ? 0xffff00 : 0xff0000)
            .addFields(
              { name: "Lavalink", value: lavalinkStatus, inline: true },
              { name: "Workers Connected", value: `${connected}/${total}`, inline: true },
              { name: "Active Sessions", value: String(sessions.size), inline: true }
            );

          const botsInfo = pool.bots
            .slice(1)
            .map((b, i) => {
              const idx = i + 1;
              const tag = b.client?.user?.tag || "(login...)";
              const ok = typeof b.hasConnectedNode === "function" ? b.hasConnectedNode() : false;
              return `#${idx} ${ok ? "✅" : "❌"} ${tag}`;
            })
            .join("\n");
          if (botsInfo) embed.addFields({ name: "Workers", value: botsInfo.slice(0, 1024) });

          // Rooms map
          const roomLines = (cfg.rooms || [])
            .map((r) => `• <#${r.voiceChannelId}> -> bot ${r.bot ?? "auto"}`)
            .join("\n");
          if (roomLines) embed.addFields({ name: "Configured Rooms", value: roomLines.slice(0, 1024) });

          // Live room status (hidden from the public panel; only here)
          const live = (cfg.rooms || [])
            .map((r) => {
              const sid = String(r.voiceChannelId);
              const s = sessions.get(sid);
              if (!s) return `• <#${sid}>: (no session yet)`;
              const st = s.getStatus?.() || {};
              const cur = st.current;
              const state = st.offline
                ? "offline"
                : st.paused
                  ? "paused"
                  : cur
                    ? "playing"
                    : "idle";
              const q = Number(st.totalQueue ?? 0);
              const title = cur?.title ? ` — ${String(cur.title).slice(0, 40)}` : "";
              return `• <#${sid}>: ${state} • Q:${q}${title}`;
            })
            .join("\n");
          if (live) embed.addFields({ name: "Room Status", value: live.slice(0, 1024) });

          return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
        }

        // Restart (host/bot) - requires Administrator.
        if (cmd === "restart") {
          const ok = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator);
          if (!ok) {
            return interaction.reply({ content: "❌ تحتاج صلاحية Administrator.", flags: EPHEMERAL });
          }
          await interaction.reply({ content: "🔄 جاري إعادة التشغيل...", flags: EPHEMERAL }).catch(() => {});
          // Let the reply flush, then exit. Pterodactyl/host should auto-restart the process.
          setTimeout(() => process.exit(0), 800);
          return;
        }

        if (mustUseControl && !inControl) {
          return interaction.reply({ content: "استخدم الأوامر في روم التحكم فقط ✅", flags: EPHEMERAL });
        }

        if (cmd === "panel") {
          await updateGlobalPanel();
          return interaction.reply({ content: "✅ تم تحديث اللوحة", flags: EPHEMERAL });
        }

        if (cmd === "rooms") {
          const roomLines = (cfg.rooms || [])
            .map((r) => {
              const bot = r.bot ? `bot #${r.bot}` : "auto";
              return `• <#${r.voiceChannelId}> -> ${bot}`;
            })
            .join("\n");
          return interaction.reply({
            content:
              roomLines ||
              "ما فيه rooms مضافة.\n\n**الحل:**\n- إمّا تعدل config.json (rooms)\n- أو استخدم /bind",
            flags: EPHEMERAL,
          });
        }

        if (cmd === "bind") {
          // صلاحية ManageGuild مفروض تكون موجودة من خلال DefaultMemberPermissions
          const room = interaction.options.getChannel("room", true);
          const botNum = interaction.options.getInteger("bot", true);

          if (workerTokens.length < botNum) {
            return interaction.reply({
              content: `❌ WORKER_TOKENS عندك ${workerTokens.length} فقط — البوت رقم ${botNum} غير موجود.`,
              flags: EPHEMERAL,
            });
          }

          const id = String(room.id);
          const existing = cfg.rooms.findIndex((r) => String(r.voiceChannelId) === id);
          const entry = { voiceChannelId: id, bot: botNum };
          if (existing >= 0) cfg.rooms[existing] = entry;
          else cfg.rooms.push(entry);
          writeConfig(cfg);

          await updateGlobalPanel();
          return interaction.reply({ content: `✅ تم ربط <#${id}> بالبوت #${botNum}`, flags: EPHEMERAL });
        }

        if (cmd === "unbind") {
          const room = interaction.options.getChannel("room", true);
          const id = String(room.id);
          cfg.rooms = cfg.rooms.filter((r) => String(r.voiceChannelId) !== id);
          writeConfig(cfg);
          await updateGlobalPanel();
          return interaction.reply({ content: `✅ تم حذف <#${id}> من القائمة`, flags: EPHEMERAL });
        }

        // ===== Music commands on user's voice room =====
        if (disableLavalink) return replyMaintenance(interaction);
        if (!interaction.guildId) return;

        const voiceId = interaction.member?.voice?.channelId || null;
        if (!voiceId) {
          return interaction.reply({ content: "ادخل روم صوتي أول ✅", flags: EPHEMERAL });
        }
        if (!isRoomAllowed(voiceId)) {
          return interaction.reply({ content: "هذا الروم مو مضاف ضمن rooms. استخدم /rooms.", flags: EPHEMERAL });
        }

        // /search (اختيار نتيجة)
        if (cmd === "search") {
          const q = interaction.options.getString("query", true);
          await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});

          const res = await getOrCreateSession({
            guildId: interaction.guildId,
            voiceChannelId: voiceId,
            textChannelId: cfg.controlTextChannelId || interaction.channelId,
          });

          if (!res.ok) return interaction.editReply({ content: res.message || "❌ فشل" });
          const session = res.session;

          const resolved = await session.resolve(q);
          if (!resolved.ok) return interaction.editReply({ content: resolved.message || "❌" });

          // لو رجع Track مباشر: أضفه فوراً
          if (resolved.type === "track") {
            const t = resolved.tracks?.[0];
            if (!t) return interaction.editReply({ content: "ما لقيت شي" });
            const addRes = session.addTrack(t, interaction.user.tag);
            if (!addRes.ok) return interaction.editReply({ content: addRes.message || "❌" });
            await session.playNextIfNeeded();
            scheduleGlobalPanelUpdate();
            return interaction.editReply({ content: `✅ تمت الإضافة: **${t.info?.title || "Unknown"}**` });
          }

          // لو بلايليست: الأفضل /play
          if (resolved.type === "playlist") {
            return interaction.editReply({
              content: `هذه بلايليست (${resolved.playlistName || "Playlist"}) — استخدم /play لإضافتها كاملة ✅`,
            });
          }

          // Search: اختر نتيجة
          const tracks = Array.isArray(resolved.tracks) ? resolved.tracks.slice(0, 10) : [];
          if (tracks.length === 0) return interaction.editReply({ content: "ما لقيت شي 😅" });

          const cacheId = putSearchCache({
            guildId: interaction.guildId,
            voiceChannelId: voiceId,
            userId: interaction.user.id,
            tracks,
          });

          const lines = tracks
            .map((t, i) => {
              const title = t?.info?.title || "Unknown";
              const author = t?.info?.author ? ` — ${t.info.author}` : "";
              return `${i + 1}) ${title}${author}`;
            })
            .join("\n");

          const embed = new EmbedBuilder()
            .setTitle("🔎 نتائج البحث")
            .setDescription(lines.slice(0, 4096));

          const menu = new StringSelectMenuBuilder()
            .setCustomId(`search_pick:${cacheId}`)
            .setPlaceholder("اختر الأغنية")
            .addOptions(
              tracks.map((t, i) => {
                const title = String(t?.info?.title || "Unknown");
                const author = String(t?.info?.author || "");
                return {
                  label: title.length > 100 ? title.slice(0, 97) + "..." : title,
                  description: author ? (author.length > 100 ? author.slice(0, 97) + "..." : author) : undefined,
                  value: String(i),
                };
              })
            );

          const row = new ActionRowBuilder().addComponents(menu);
          return interaction.editReply({ embeds: [embed], components: [row] });
        }

        // /play و /p
        if (cmd === "play" || cmd === "p") {
          const q = interaction.options.getString("query", true);
          await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});

          const res = await getOrCreateSession({
            guildId: interaction.guildId,
            voiceChannelId: voiceId,
            textChannelId: cfg.controlTextChannelId || interaction.channelId,
          });

          if (!res.ok) return interaction.editReply({ content: res.message || "❌ فشل" });
          const session = res.session;

          const addRes = await session.add(q, interaction.user.tag);
          if (!addRes.ok) return interaction.editReply({ content: addRes.message });

          await session.playNextIfNeeded();
          scheduleGlobalPanelUpdate();

          return interaction.editReply({
            content: addRes.playlist ? `✅ تم إضافة بلايليست (${addRes.added})` : `✅ تمت الإضافة (${addRes.added})`,
          });
        }

        const s = sessions.get(key(interaction.guildId, voiceId));
        if (!s) {
          return interaction.reply({ content: "ما فيه جلسة شغالة للروم هذا حالياً.", flags: EPHEMERAL });
        }

        if (cmd === "skip") {
          await s.skip();
          scheduleGlobalPanelUpdate();
          return interaction.reply({ content: "⏭️", flags: EPHEMERAL });
        }
        if (cmd === "pause") {
          if (!s.paused) await s.togglePause();
          scheduleGlobalPanelUpdate();
          return interaction.reply({ content: "⏸️", flags: EPHEMERAL });
        }
        if (cmd === "resume") {
          if (s.paused) await s.togglePause();
          scheduleGlobalPanelUpdate();
          return interaction.reply({ content: "▶️", flags: EPHEMERAL });
        }
        if (cmd === "stop") {
          await s.stop();
          scheduleGlobalPanelUpdate();
          return interaction.reply({ content: "🛑", flags: EPHEMERAL });
        }
        if (cmd === "queue") {
          const st = s.getStatus();
          const lines = st.upcoming.map((t, i) => `${i + 1}) ${t.title} — ${t.requester}`).join("\n") || "—";
          return interaction.reply({ content: `**Up Next**\n${lines}`, flags: EPHEMERAL });
        }
      }
    } catch (e) {
      console.error("[Interaction Error]", e);
      if (interaction?.isRepliable?.()) {
        try {
          await interaction.reply({ content: "❌ صار خطأ داخلي.", flags: EPHEMERAL });
        } catch {}
      }
    }
  });

  // شغّل كل البوتات (Manager + Workers)
  // تشغيلها كلها مرة وحدة ممكن يسبب Identify rate-limit في Discord خصوصاً مع عدد كبير.
  // لذلك نخلي الدخول تدريجي للبوتات (خصوصاً على الاستضافات المشتركة).
  const loginDelay = Number(process.env.WORKER_LOGIN_DELAY_MS || "3500");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function joinConfiguredRoomsAfterStartup() {
    if (disableLavalink || !cfg.keep24_7 || !(cfg.rooms && cfg.rooms.length)) return;

    // تأكد إن المانجر جاهز
    if (typeof manager.isReady === "function" && !manager.isReady()) {
      await new Promise((res) => manager.once("ready", res));
    }

    // انتظر Lavalink لكل Worker مستخدم (لتقليل أخطاء NO_LAVALINK_NODE)
    const want = new Set(
      (cfg.rooms || [])
        .map((r) => Number(r.bot))
        .filter((n) => Number.isInteger(n) && n >= 1)
    );

    const timeout = Number(process.env.LAVALINK_READY_TIMEOUT_MS || "45000");
    if (want.size === 0) {
      const first = pool.bots[1];
      if (first && typeof first.waitForNodeReady === "function") {
        await first.waitForNodeReady(timeout).catch(() => false);
      }
    } else {
      for (const idx of want) {
        const b = pool.bots[idx];
        if (b && typeof b.waitForNodeReady === "function") {
          await b.waitForNodeReady(timeout).catch(() => false);
        }
      }
    }

    console.log("[24/7] Joining configured rooms (after workers startup)...");

    // Join كل روم حسب guildId الحقيقي (من fetch للقناة) — هذا يحل مشاكل تعدد السيرفرات/غلط GUILD_ID
    for (const r of cfg.rooms) {
      const voiceId = String(r?.voiceChannelId || "").trim();
      if (!voiceId) continue;

      // جرب نجيب guildId من القناة نفسها
      let gid = null;
      try {
        const ch = await manager.channels.fetch(voiceId);
        gid = ch?.guildId || null;
      } catch {}

      if (!gid) {
        console.warn(`[24/7] ⚠️ ما قدرت أجيب guildId للروم ${voiceId} — تأكد البوت داخل السيرفر وصلاحياته.`);
        continue;
      }

      // حاول join (مع retry بسيط)
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await getOrCreateSession({
            guildId: gid,
            voiceChannelId: voiceId,
            textChannelId: cfg.controlTextChannelId,
          });

          if (!res.ok) {
            lastErr = res.message || "unknown";
            throw new Error(lastErr);
          }

          console.log(`[24/7] ✅ Joined <#${voiceId}> (bot #${r?.bot ?? "auto"})`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e?.message || String(e);
          // لو المشكلة NO_LAVALINK_NODE انتظر ثم أعد المحاولة
          if (/NO_LAVALINK_NODE/i.test(lastErr) || /No connected nodes/i.test(lastErr)) {
            await sleep(1500 * attempt);
            continue;
          }
          await sleep(600 * attempt);
        }
      }

      if (lastErr) {
        console.warn(`[24/7] ❌ Failed to join <#${voiceId}>: ${lastErr}`);
      }

      if (ROOM_JOIN_DELAY_MS > 0) await sleep(ROOM_JOIN_DELAY_MS);
    }

    await updateGlobalPanel().catch(() => {});
  }


  console.log("🚀 Starting manager bot...");
  await pool.bots[0].login();

  console.log(`🚀 Starting ${pool.bots.length - 1} worker bots with ${loginDelay}ms delay...`);
  for (let i = 1; i < pool.bots.length; i++) {
    try {
      await pool.bots[i].login();
    } catch (e) {
      console.error(`❌ Worker #${i} فشل تسجيل الدخول:`, e?.message || e);
    }
    // لا نأخر بعد آخر بوت
    if (i < pool.bots.length - 1) await sleep(loginDelay);
  }

  // ===== Lavalink failover / auto recovery =====
  // If one Lavalink node goes down while a player is active, Shoukaku may reconnect
  // but some players can become stale. We mark affected sessions as node-down and
  // recover them onto any other connected node.
  const FAILOVER_WATCHDOG_SEC = Number(process.env.FAILOVER_WATCHDOG_SEC || "8");
  const FAILOVER_STAGGER_MS = Number(process.env.FAILOVER_RECOVER_STAGGER_MS || "600");

  function attachNodeFailoverHandlers(workerBot) {
    const shoukaku = workerBot?.shoukaku;
    if (!shoukaku) return;

    const onNodeDown = async (nodeName, why) => {
      const affected = [...sessions.values()].filter((s) => {
        if (!s || s.bot !== workerBot) return false;
        const hasWork = Boolean(s.current) || (Array.isArray(s.queue) && s.queue.length > 0);
        if (!hasWork) return false;
        const pn = s.player?.node?.name;
        // If player is on that node OR player missing (stale) but session is active.
        return !pn || String(pn) === String(nodeName);
      });

      if (affected.length) {
        console.warn(`[FAILOVER] Node down (${nodeName}) -> recovering ${affected.length} session(s). ${why || ""}`);
      }

      // Mark sessions down first, then recover with small stagger to reduce spikes.
      for (const s of affected) {
        try { s.markNodeDown(`node ${nodeName} ${why || ""}`); } catch {}
      }

      for (const s of affected) {
        await sleep(FAILOVER_STAGGER_MS);
        try { await s.recoverIfNeeded?.(); } catch {}
      }
    };

    const onNodeReady = async (nodeName) => {
      if (!AUTO_MIGRATE_BACK_TO_PRIMARY) return;
      if (String(nodeName) !== String(PRIMARY_NODE_NAME)) return;

      // When primary returns, request sessions on this worker to move back.
      const list = [...sessions.values()].filter((s) => s && s.bot === workerBot);
      const targets = list.filter((s) => {
        const hasConn = Boolean(s.player);
        const onPrimary = String(s.player?.node?.name || "") === String(PRIMARY_NODE_NAME);
        return hasConn && !onPrimary;
      });

      if (targets.length) {
        console.log(`[MIGRATE] Primary node READY (${PRIMARY_NODE_NAME}) -> scheduling ${targets.length} session(s) to migrate back`);
      }

      for (const s of targets) {
        try { s.requestMigrateBackToPrimary?.("primary ready"); } catch {}
      }

      // Try to migrate immediately (sessions with YT playing may defer until end)
      for (const s of targets) {
        await sleep(AUTO_MIGRATE_BACK_STAGGER_MS);
        try { await s.migrateBackToPrimary?.(); } catch {}
      }
    };

    shoukaku.on("close", (name, code, reason) => onNodeDown(name, `CLOSE ${code} ${reason || ""}`));
    shoukaku.on("disconnect", (name, reason) => onNodeDown(name, `DISCONNECT ${reason || ""}`));

    // Shoukaku emits "ready" when a node becomes available again.
    // Some versions also emit "nodeReady".
    shoukaku.on("ready", (name) => onNodeReady(name).catch(() => {}));
    shoukaku.on("nodeReady", (name) => onNodeReady(name).catch(() => {}));
  }

  // attach for all workers
  pool.bots.slice(1).forEach((b) => attachNodeFailoverHandlers(b));

  if (FAILOVER_WATCHDOG_SEC > 0) {
    setInterval(() => {
      for (const s of sessions.values()) {
        try {
          const hasWork = Boolean(s?.current) || (Array.isArray(s?.queue) && s.queue.length > 0);
          if (!hasWork) continue;
          const p = s?.player;
          const ok = p && typeof s._isPlayerUsable === "function" ? s._isPlayerUsable(p) : Boolean(p);
          if (!ok) {
            s.markNodeDown("watchdog");
            s.recoverIfNeeded?.().catch(() => {});
          }
        } catch {}
      }
    }, FAILOVER_WATCHDOG_SEC * 1000);
  }

  // 24/7 join after all workers are logged in
  await joinConfiguredRoomsAfterStartup();

  // تحديث أولي بعد 5 ثواني
  setTimeout(() => {
    console.log("📊 Lavalink status:");
    pool.bots.slice(1).forEach((b, i) => {
      const idx = i + 1;
      const tag = b.client?.user?.tag || "Unknown";
      const ok = typeof b.hasConnectedNode === "function" ? b.hasConnectedNode() : false;
      console.log(`  Worker #${idx} (${tag}): ${ok ? "✅" : "❌"}`);
    });
    updateGlobalPanel().catch(() => {});
  }, 5000);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

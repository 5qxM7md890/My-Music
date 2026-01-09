// src/panel.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

function emojiTag(e) {
  // Accept a pre-resolved tag string (e.g. '<:name:id>')
  if (typeof e === "string") return e;
  if (e && typeof e.tag === "string") return e.tag;

  // default fallback
  if (!e || !e.id) return "🎵";
  const name = e.name ? String(e.name).replace(/:/g, "") : "emoji";
  return `<:${name}:${e.id}>`;
}

function clamp(str, max) {
  const s = String(str ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const total = Math.floor(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function progressBar(positionMs, lengthMs, size = 14) {
  const len = Number(lengthMs);
  const pos = Number(positionMs);
  if (!Number.isFinite(len) || len <= 0) return null;
  const p = Math.min(1, Math.max(0, (Number.isFinite(pos) ? pos : 0) / len));
  const filled = Math.round(p * size);
  const empty = Math.max(0, size - filled);
  return `▰`.repeat(filled) + `▱`.repeat(empty);
}

function statusColor({ offline, paused, hasTrack }) {
  if (offline) return 0xED4245; // red
  if (hasTrack && paused) return 0xFEE75C; // yellow
  if (hasTrack) return 0x57F287; // green
  return 0x5865F2; // blurple
}

function loopLabel(mode) {
  if (mode === 1) return "🔂"; // Track
  if (mode === 2) return "🔁"; // Queue
  return "⏭️"; // Off
}

// (Legacy) Single-room panel builder (kept for compatibility)
function buildPanel(status) {
  const offline = Boolean(status?.offline);
  const current = status?.current;
  const hasTrack = Boolean(current);

  const embed = new EmbedBuilder()
    .setTitle("🎵 Oasis Music")
    .setColor(statusColor({ offline, paused: Boolean(status?.paused), hasTrack }))
    .setDescription(
      offline
        ? "⚠️ **Lavalink غير متصل** — الموسيقى متوقفة مؤقتًا."
        : hasTrack
          ? `**🎧 الآن يشغل**\n${current.uri ? `[${clamp(current.title, 80)}](${current.uri})` : clamp(current.title, 80)}`
          : "✨ **جاهز** — ما فيه شيء شغال الآن."
    );

  if (hasTrack) {
    const bar = progressBar(status?.position, current.length);
    const line = bar
      ? `${fmtMs(status?.position)} / ${fmtMs(current.length)}\n${bar}`
      : `${fmtMs(current.length)}`;
    embed.addFields({ name: "الوقت", value: line, inline: false });
    if (current.artworkUrl) embed.setThumbnail(current.artworkUrl);
  }

  return { embeds: [embed], components: [] };
}

// ===== Public (Global) Panel =====
// ✅ جماليات + بانر
// ✅ بدون إحصائيات/قائمة رومات (الـ stats خليها لـ /debug)
function buildGlobalPanel({ offline, emojis = null, brand = null, autoRefreshSec = null, updatedUnix = null }) {
  const note = emojiTag(emojis?.musicNote || emojis?.note || emojis?.music || null);

  const statusLine = offline ? "🔴 Offline" : "🟢 Online";
  const autoLine = autoRefreshSec && autoRefreshSec > 0 ? `Auto Refresh: ${autoRefreshSec}s` : "Auto Refresh: Off";
  const updatedLine = updatedUnix ? `\n<t:${updatedUnix}:R>` : "";

  const embed = new EmbedBuilder()
    .setTitle(`${note} Oasis Music Panel`)
    .setColor(statusColor({ offline, paused: false, hasTrack: !offline }))
    .setDescription(
      offline
        ? `**${statusLine}**\nLavalink غير متصل حالياً.\nجرّب بعد شوي.\n\n${autoLine}${updatedLine}`
        : `**${statusLine}**\nاضغط **My Room Panel** عشان تفتح لوحة رومك الصوتي.\n\n${autoLine}${updatedLine}`
    )
    .setFooter({ text: "Oasis Music • Multi‑Room" });

  if (brand?.name) {
    embed.setAuthor({ name: brand.name, iconURL: brand.iconURL || undefined });
  }
  if (brand?.bannerURL) embed.setImage(brand.bannerURL);
  if (brand?.iconURL) embed.setThumbnail(brand.iconURL);

  const btnRoom = new ButtonBuilder()
    .setCustomId("open_room_panel")
    .setLabel("My Room Panel")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(Boolean(offline));

  const btnRefresh = new ButtonBuilder()
    .setCustomId("refresh_global_panel")
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary);

  const roomEmoji = emojis?.myRoomPanel || emojis?.roomPanel || emojis?.myRoom || null;
  const refreshEmoji = emojis?.refresh || null;

  if (roomEmoji?.id) {
    btnRoom.setEmoji({
      id: String(roomEmoji.id),
      name: roomEmoji.name ? String(roomEmoji.name).replace(/:/g, "") : undefined,
    });
  }
  if (refreshEmoji?.id) {
    btnRefresh.setEmoji({
      id: String(refreshEmoji.id),
      name: refreshEmoji.name ? String(refreshEmoji.name).replace(/:/g, "") : undefined,
    });
  }

  const row = new ActionRowBuilder().addComponents(btnRoom, btnRefresh);
  return { embeds: [embed], components: [row] };
}

// ===== Private (Ephemeral) Room Panel =====
function buildRoomPanel({ voiceChannelId, status, roomName = null, emojis = null, brand = null }) {
  const offline = Boolean(status?.offline);
  const current = status?.current;
  const hasTrack = Boolean(current);
  const note = emojiTag(emojis?.musicNote || emojis?.note || emojis?.music || null);

  const embed = new EmbedBuilder()
    .setColor(statusColor({ offline, paused: Boolean(status?.paused), hasTrack }))
    .setFooter({
      text: offline
        ? "Oasis Music"
        : `${loopLabel(status?.repeatMode || 0)}  •  📜 ${status?.totalQueue ?? 0}`,
    })
    .setTimestamp(new Date());

  // Header/Brand
  if (brand?.name) {
    embed.setAuthor({
      name: roomName ? `${brand.name} • ${roomName}` : `${brand.name} • My Room`,
      iconURL: brand.iconURL || undefined,
    });
  } else {
    embed.setAuthor({ name: roomName || "My Room", iconURL: brand?.iconURL || undefined });
  }

  if (brand?.bannerURL) embed.setImage(brand.bannerURL);

  // Content
  if (offline) {
    embed
      .setTitle(`${note} My Room Panel`)
      .setDescription(`⚠️ Lavalink غير متصل حالياً.\n\n🔊 رومك: <#${voiceChannelId}>`);
    if (brand?.iconURL) embed.setThumbnail(brand.iconURL);
  } else if (!hasTrack) {
    embed
      .setTitle(`${note} My Room Panel`)
      .setDescription(`🔊 رومك: <#${voiceChannelId}>\n\n✨ ما فيه شيء شغال الآن.`);
    if (brand?.iconURL) embed.setThumbnail(brand.iconURL);
  } else {
    const title = clamp(current.title, 80);
    const trackLine = current.uri ? `[${title}](${current.uri})` : title;
    const bar = progressBar(status?.position, current.length);
    const timeLine = bar
      ? `${fmtMs(status?.position)} / ${fmtMs(current.length)}\n${bar}`
      : `${fmtMs(current.length)}`;

    embed
      .setTitle("Now Playing ♪")
      .setDescription(
        `🔊 رومك: <#${voiceChannelId}>\n\n${trackLine}\n\n${timeLine}` +
          (current.requester ? `\n\n👤 ${clamp(current.requester, 40)}` : "")
      );

    if (current.artworkUrl) embed.setThumbnail(current.artworkUrl);
    else if (brand?.iconURL) embed.setThumbnail(brand.iconURL);
  }

  // Buttons (Emoji-only for a clean look)
  const suf = String(voiceChannelId);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_toggle:${suf}`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⏯️")
      .setDisabled(offline || !current),
    new ButtonBuilder()
      .setCustomId(`music_skip:${suf}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⏭️")
      .setDisabled(offline || !current),
    new ButtonBuilder()
      .setCustomId(`music_stop:${suf}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹️")
      .setDisabled(offline || !current)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_loop:${suf}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔁")
      .setDisabled(offline || !current),
    new ButtonBuilder()
      .setCustomId(`music_shuffle:${suf}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔀")
      .setDisabled(offline || !current || (status?.totalQueue || 0) < 2),
    new ButtonBuilder()
      .setCustomId(`music_queue:${suf}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📜")
      .setDisabled(offline || (status?.totalQueue || 0) === 0)
  );

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = { buildPanel, buildGlobalPanel, buildRoomPanel };

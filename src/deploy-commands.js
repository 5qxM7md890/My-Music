require("dotenv").config();
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

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

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("إعادة تشغيل البوت/الهوست (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

new SlashCommandBuilder().setName("debug").setDescription("معلومات تشخيصية عن Lavalink والبوتات"),
].map((c) => c.toJSON());

(async () => {
  const token = (process.env.MANAGER_TOKEN || "").trim();
  const clientId = (process.env.CLIENT_ID || "").trim();
  const guildId = (process.env.GUILD_ID || "").trim();

  if (!token || !clientId || !guildId) {
    console.error("تأكد من MANAGER_TOKEN / CLIENT_ID / GUILD_ID في .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log("✅ تم تسجيل الأوامر في السيرفر");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

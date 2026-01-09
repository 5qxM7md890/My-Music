const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { Shoukaku, Connectors } = require("shoukaku");

class BotInstance {
  constructor({ token, isManager, lavalinkNodes, disableLavalink }) {
    this.token = token;
    this.isManager = isManager;

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ];
    if (isManager) {
      // Needed for custom emoji caching (panel button emojis).
      intents.push(GatewayIntentBits.GuildEmojisAndStickers);
      intents.push(GatewayIntentBits.GuildMessages);
      // Required to read non-mention text (for prefix/Arabic text commands).
      intents.push(GatewayIntentBits.MessageContent);
    }

    this.client = new Client({
      intents,
      partials: [Partials.Channel],
    });

    this.shoukaku = null;

    // Promise نحلّها أول ما أي Node يصير READY
    this._nodeReadyResolve = null;
    this.nodeReady = new Promise((resolve) => (this._nodeReadyResolve = resolve));

    if (!disableLavalink && Array.isArray(lavalinkNodes) && lavalinkNodes.length > 0) {
      this.shoukaku = new Shoukaku(
        new Connectors.DiscordJS(this.client),
        // ضيف secure لو تحتاجه (عادة false)
        lavalinkNodes.map((n) => ({ ...n, secure: n.secure === true })),
        {
          resume: true,
          resumeByLibrary: true,
          resumeKey: process.env.LAVALINK_RESUME_KEY || "multiroom-session",
          resumeTimeout: 60,
          reconnectTries: 10,
          reconnectInterval: 5,
          restTimeout: 120,
          voiceConnectionTimeout: 30,
        }
      );

      this.shoukaku.on("ready", (name) => {
        console.log(`[Shoukaku:${isManager ? "manager" : "worker"}] Node READY -> ${name}`);
        this._nodeReadyResolve?.(true);
      });

      this.shoukaku.on("error", (_, error) => {
        console.warn(
          `[Shoukaku:${isManager ? "manager" : "worker"}]`,
          error?.code || error?.message || error
        );
      });

      this.shoukaku.on("close", (name, code, reason) => {
        console.warn(
          `[Shoukaku:${isManager ? "manager" : "worker"}] Node CLOSE -> ${name} (${code}) ${reason || ""}`
        );
        // نرجّع promise جديد للـ ready القادم
        this.nodeReady = new Promise((resolve) => (this._nodeReadyResolve = resolve));
      });

      this.shoukaku.on("disconnect", (name, reason) => {
        console.warn(
          `[Shoukaku:${isManager ? "manager" : "worker"}] Node DISCONNECT -> ${name} ${reason || ""}`
        );
        this.nodeReady = new Promise((resolve) => (this._nodeReadyResolve = resolve));
      });
    }
  }

  async waitForNodeReady(timeoutMs = 15000) {
    if (!this.shoukaku) return false;

    // إذا فيه node جاهز أساساً
    const hasReady =
      [...this.shoukaku.nodes.values()].some((n) => n && (n.state === 2 || n.state === 1));
    if (hasReady) return true;

    // انتظر أول ready
    return await Promise.race([
      this.nodeReady,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }


  getConnectedNodes() {
    if (!this.shoukaku) return [];
    // Shoukaku v4: CONNECTED = 2, NEARLY = 1
    return [...this.shoukaku.nodes.values()].filter((n) => n && (n.state === 2 || n.state === 1));
  }

  hasConnectedNode() {
    return this.getConnectedNodes().length > 0;
  }

  async login() {
    await this.client.login(this.token);
  }
}

class BotPool {
  constructor({ managerToken, workerTokens, lavalinkNodes, disableLavalink }) {
    this.bots = [];
    this.bots.push(
      // ملاحظة: البوت المدير ما نستخدمه للدخول للرومات الصوتية.
      // لذلك لا نحتاج Lavalink عليه (يخفف الحمل ويضمن ما يدخل بالغلط).
      new BotInstance({ token: managerToken, isManager: true, lavalinkNodes: [], disableLavalink: true })
    );

    for (const t of workerTokens) {
      this.bots.push(
        new BotInstance({ token: t, isManager: false, lavalinkNodes, disableLavalink })
      );
    }

    this.assignments = new Map(); // guildId -> Map(voiceChannelId -> botIndex)
  }

  get manager() {
    return this.bots[0];
  }

  getAssignedBotIndex(guildId, voiceChannelId) {
    const g = this.assignments.get(guildId);
    return g?.get(voiceChannelId) ?? null;
  }

  assignBot(guildId, voiceChannelId, botIndex) {
    if (!this.assignments.has(guildId)) this.assignments.set(guildId, new Map());
    this.assignments.get(guildId).set(voiceChannelId, botIndex);
  }

  findFreeBotForGuild(guildId) {
    const g = this.assignments.get(guildId);
    const busy = new Set(g ? [...g.values()] : []);
    // نبدأ من 1 لأن 0 هو المدير
    for (let i = 1; i < this.bots.length; i++) {
      if (!busy.has(i)) return i;
    }
    return null;
  }

  isValidWorkerIndex(botIndex) {
    const i = Number(botIndex);
    return Number.isInteger(i) && i >= 1 && i < this.bots.length;
  }

  isBotFreeInGuild(guildId, botIndex) {
    const g = this.assignments.get(guildId);
    if (!g) return true;
    for (const used of g.values()) {
      if (used === botIndex) return false;
    }
    return true;
  }

  allocateSpecific(guildId, voiceChannelId, botIndex) {
    if (!this.isValidWorkerIndex(botIndex)) return null;
    if (!this.isBotFreeInGuild(guildId, botIndex)) return null;
    this.assignBot(guildId, voiceChannelId, botIndex);
    return botIndex;
  }

  getOrAllocateBot(guildId, voiceChannelId) {
    const existing = this.getAssignedBotIndex(guildId, voiceChannelId);
    if (existing !== null) return existing;

    const free = this.findFreeBotForGuild(guildId);
    if (free === null) return null;

    this.assignBot(guildId, voiceChannelId, free);
    return free;
  }
}

module.exports = { BotPool };

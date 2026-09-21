import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateConfig, type Config } from "./config.js";
import { digest } from "./contracts.js";
import type { Host } from "./host.js";
import {
  discoverBot,
  readSecrets,
  writeSecrets,
  type RobotInput,
} from "./bot-setup.js";

export class ConfigurationManager {
  readonly file: string;
  busy = false;
  constructor(
    file: string,
    readonly host: Host,
  ) {
    this.file = realpathSync(file);
  }
  private read() {
    const raw = readFileSync(this.file, "utf8");
    return { raw, revision: digest(raw), config: JSON.parse(raw) };
  }
  get pendingRestart() {
    return (
      digest(validateConfig(this.read().config, this.file)) !==
      digest(this.host.config)
    );
  }
  snapshot() {
    const { config, revision } = this.read();
    return {
      config: validateConfig(config, this.file),
      revision,
      pendingRestart: this.pendingRestart,
      secrets: this.host.config.bots.map((b) => ({
        botId: b.id,
        variable: b.appSecretEnv,
        present: !!process.env[b.appSecretEnv],
      })),
      file: this.file,
    };
  }
  validate(input: unknown): Config {
    const candidate = validateConfig(input, this.file);
    if (
      candidate.stateDir !== this.host.config.stateDir ||
      candidate.port !== this.host.config.port
    )
      throw new Error("runtime_location_readonly");
    if (!candidate.agents.length) throw new Error("agent_project_required");
    return candidate;
  }
  async saveRobot(
    input: RobotInput,
    discover = discoverBot,
    appType?: "personal-agent",
  ) {
    if (!path.basename(this.file).includes(".local."))
      throw new Error("local_config_file_required");
    const before = this.snapshot();
    if (input.revision !== before.revision)
      throw new Error("config_revision_conflict");
    const cfg = structuredClone(before.config);
    if (
      !cfg.projects.some((p) => p.id === input.projectId) ||
      !cfg.agents.some((a) => a.id === input.agentId)
    )
      throw new Error("invalid_local_scope");
    const existing = cfg.bots.find((b) => b.id === input.id);
    if (cfg.bots.some((b) => b.id !== input.id && b.appId === input.appId))
      throw new Error("bots_must_use_distinct_apps");
    const changed =
      !existing ||
      existing.appId !== input.appId ||
      existing.tenant !== input.tenant ||
      !!input.secret;
    if (changed && !input.secret) throw new Error("lark_secret_required");
    const identity = changed
      ? await discover(input.tenant, input.appId, input.secret!)
      : { openId: existing!.selfOpenId, tenantKey: existing!.tenantKey };
    const secretKey = changed
      ? `EASY_LARKY_SECRET_${randomUUID().replaceAll("-", "").toUpperCase()}`
      : existing!.appSecretEnv;
    const bot: Config["bots"][number] = {
      ...(existing ?? { appType: appType ?? ("custom" as const), peers: {} }),
      id: input.id,
      name: input.name,
      projectId: input.projectId,
      agentId: input.agentId,
      tenant: input.tenant,
      appId: input.appId,
      appSecretEnv: secretKey,
      selfOpenId: identity.openId,
      tenantKey: identity.tenantKey,
    };
    // Omitted model preserves older clients; changing runtime must not carry an old override.
    if (input.model !== undefined || existing?.agentId !== input.agentId) {
      delete bot.model;
      if (input.model) bot.model = input.model;
    }
    const identityChanged =
      existing &&
      (existing.appId !== input.appId ||
        existing.tenant !== input.tenant ||
        existing.selfOpenId !== identity.openId ||
        existing.tenantKey !== identity.tenantKey);
    if (identityChanged && cfg.bindings.some((b) => b.botId === input.id))
      throw new Error("bot_replacement_requires_review");
    if (identityChanged) {
      bot.peers = {};
      bot.allowedUsers = [];
      bot.allowAllUsers = false;
    }
    bot.peers = Object.fromEntries(
      Object.entries(bot.peers).filter(([agent]) => agent !== bot.agentId),
    );
    cfg.bots = [...cfg.bots.filter((b) => b.id !== input.id), bot];
    for (const binding of cfg.bindings)
      if (binding.botId === bot.id) binding.projectId = input.projectId;
    this.validate(cfg);
    if (input.revision !== this.snapshot().revision)
      throw new Error("config_revision_conflict");
    const secrets = readSecrets(this.file);
    if (changed)
      writeSecrets(this.file, { ...secrets, [secretKey]: input.secret! });
    try {
      return this.save(cfg, input.revision);
    } catch (e) {
      if (changed) writeSecrets(this.file, secrets);
      throw e;
    }
  }
  assertIdle() {
    if (this.busy) throw new Error("connection_busy");
    if (
      this.host.active.size ||
      this.host.store
        .runs()
        .some((r) => ["queued", "running", "waiting"].includes(r.state)) ||
      this.host.store
        .deliveries()
        .some((d) =>
          ["pending", "sending", "unknown", "blocked"].includes(d.state),
        )
    )
      throw new Error("config_change_requires_review");
  }
  save(input: unknown, revision: string) {
    this.assertIdle();
    const previous = this.read();
    if (revision !== previous.revision)
      throw new Error("config_revision_conflict");
    const candidate = this.validate(input);
    const nonterminal = new Set(["queued", "running", "waiting"]);
    if (
      this.host.active.size ||
      this.host.store.runs().some((r) => nonterminal.has(r.state)) ||
      this.host.store
        .deliveries()
        .some((d) =>
          ["pending", "sending", "unknown", "blocked"].includes(d.state),
        )
    )
      throw new Error("config_change_requires_review");
    // Keep credentials/local configuration out of tracked files. Same-directory rename is atomic.
    if (!path.basename(this.file).includes(".local."))
      throw new Error("local_config_file_required");
    const backup = `${this.file}.backup-${Date.now()}-${randomUUID()}`;
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    writeFileSync(backup, previous.raw, { mode: 0o600, flag: "wx" });
    try {
      writeFileSync(temporary, JSON.stringify(candidate, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.host.store.audit("config_saved", "local-operator", digest(candidate));
    return { ...this.snapshot(), backup, status: "saved" };
  }
}

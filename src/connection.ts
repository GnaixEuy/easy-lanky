import { randomUUID } from "node:crypto";
import type { ConfigurationManager } from "./configuration.js";
import type { Inbound } from "./contracts.js";
import { digest } from "./contracts.js";
import { loadSecrets } from "./bot-setup.js";
import { CliAdapter } from "./adapters/cli.js";

type Channel = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): { botId: string; connection?: string }[];
};
type Candidate = {
  id: string;
  botId: string;
  chatId: string;
  threadId: string | null;
  senderId: string;
  chatType?: string;
  preview: string;
  expiresAt: number;
};
export class ConnectionService {
  offline = true;
  private closing = false;
  private candidates = new Map<string, Candidate>();
  lastInbound: { at: number; botId: string; status: string } | null = null;
  constructor(
    readonly manager: ConfigurationManager,
    readonly transport: Channel,
  ) {}
  get busy() {
    return this.manager.busy;
  }
  snapshot() {
    for (const [id, c] of this.candidates)
      if (c.expiresAt <= Date.now()) this.candidates.delete(id);
    return {
      mode: this.offline ? "offline" : "lark",
      busy: this.busy,
      channels: this.transport.status(),
      candidates: [...this.candidates.values()],
      lastInbound: this.lastInbound,
    };
  }
  async connect() {
    this.manager.assertIdle();
    if (this.closing) throw new Error("host_stopping");
    const config = this.manager.snapshot().config;
    if (!config.bots.length) throw new Error("no_bots_configured");
    this.manager.busy = true;
    this.offline = true;
    try {
      await this.transport.disconnect();
      if (this.closing) throw new Error("host_stopping");
      loadSecrets(this.manager.file);
      const host = this.manager.host;
      Object.assign(host.config, config);
      host.adapters.clear();
      for (const a of config.agents)
        host.adapters.set(
          a.id,
          new CliAdapter(a, config.stateDir, config.runTimeoutMs),
        );
      host.store.db
        .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
        .run("config", digest(config));
      this.candidates.clear();
      await this.transport.connect();
      if (this.closing) throw new Error("host_stopping");
      this.offline = false;
    } catch {
      await this.transport.disconnect();
      throw new Error("lark_connection_failed");
    } finally {
      this.manager.busy = false;
    }
    return this.snapshot();
  }
  async stop() {
    this.closing = true;
    this.offline = true;
    await this.transport.disconnect();
  }
  receive(event: Inbound) {
    if (this.offline || this.busy || this.closing)
      return { status: "connection_not_ready" };
    const host = this.manager.host;
    const result = host.receive(event);
    this.lastInbound = {
      at: Date.now(),
      botId: event.botId,
      status: result.status,
    };
    const bot = host.config.bots.find((b) => b.id === event.botId);
    // Only real, directed human messages can propose an authorization. Never execute or reply before approval.
    if (
      ["unbound_target", "user_not_authorized"].includes(result.status) &&
      bot &&
      event.tenantKey === bot.tenantKey &&
      event.senderType === "human" &&
      event.senderId !== bot.selfOpenId &&
      !event.mentionAll &&
      (event.chatType === "p2p" || event.mentions.includes(bot.selfOpenId))
    ) {
      this.snapshot();
      const prior = [...this.candidates.values()].find(
        (c) =>
          c.botId === event.botId &&
          c.chatId === event.chatId &&
          c.threadId === event.threadId &&
          c.senderId === event.senderId,
      );
      if (prior || this.candidates.size < 100) {
        const id = prior?.id ?? randomUUID();
        this.candidates.set(id, {
          id,
          botId: event.botId,
          chatId: event.chatId,
          threadId: event.threadId,
          senderId: event.senderId,
          chatType: event.chatType,
          preview: event.text.slice(0, 120),
          expiresAt: Date.now() + 600000,
        });
      }
    }
    return result;
  }
  revoke(bindingId: string, userId: string, revision: string) {
    this.manager.assertIdle();
    if (this.closing) throw new Error("host_stopping");
    if (this.manager.pendingRestart) throw new Error("config_restart_required");
    const config = this.manager.snapshot().config;
    const binding = config.bindings.find((b) => b.id === bindingId);
    if (!binding?.allowedUsers.includes(userId))
      throw new Error("user_not_authorized");
    binding.allowedUsers = binding.allowedUsers.filter((id) => id !== userId);
    this.manager.save(config, revision);
    this.manager.host.config.bindings = config.bindings;
    this.manager.host.store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run("config", digest(this.manager.host.config));
    this.manager.host.store.audit(
      "access_revoked",
      bindingId,
      JSON.stringify({ userId }),
    );
    return this.manager.snapshot();
  }
  authorize(id: string, revision: string) {
    this.manager.assertIdle();
    if (this.closing || this.offline) throw new Error("connection_not_ready");
    if (this.manager.pendingRestart) throw new Error("config_restart_required");
    this.snapshot();
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error("conversation_expired");
    const config = this.manager.snapshot().config;
    const bot = config.bots.find((b) => b.id === candidate.botId);
    if (!bot?.projectId) throw new Error("invalid_local_scope");
    const existing = config.bindings.find(
      (b) =>
        b.botId === candidate.botId &&
        b.chatId === candidate.chatId &&
        b.threadId === candidate.threadId,
    );
    if (existing) {
      if (!existing.allowedUsers.includes(candidate.senderId))
        existing.allowedUsers.push(candidate.senderId);
      existing.allowSend = true;
    } else
      config.bindings.push({
        id: `binding-${randomUUID()}`,
        botId: candidate.botId,
        chatId: candidate.chatId,
        threadId: candidate.threadId,
        projectId: bot.projectId,
        allowedUsers: [candidate.senderId],
        allowedAgents: [],
        allowWrites: false,
        allowSend: true,
      });
    this.manager.save(config, revision);
    const approvedBinding = config.bindings.find(
      (b) =>
        b.botId === candidate.botId &&
        b.chatId === candidate.chatId &&
        b.threadId === candidate.threadId,
    )!;
    this.manager.host.store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run(
        `message-recovery:${approvedBinding.id}`,
        JSON.stringify({ since: Date.now() }),
      );
    this.manager.host.config.bindings = config.bindings;
    this.manager.host.store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run("config", digest(this.manager.host.config));
    this.candidates.delete(id);
    return this.manager.snapshot();
  }
}

import { messageContent } from "./message-content.js";
import { isUserAllowed } from "./access.js";
import type { Binding } from "./config.js";
import type { Host } from "./host.js";
import { digest, type Inbound } from "./contracts.js";
export type HistoryPage = {
  items?: any[];
  has_more?: boolean;
  page_token?: string;
};
export class MessageRecovery {
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(
    readonly host: Host,
    readonly ready: () => boolean,
    readonly history: (
      binding: Binding,
      since: number,
      until: number,
      page?: string,
    ) => Promise<HistoryPage>,
    readonly receive: (event: Inbound) => { status: string },
    readonly log: (event: object) => void,
  ) {}
  tick() {
    if (this.pending || this.stopped || !this.ready()) return;
    this.pending = this.poll()
      .catch(() => this.log({ kind: "message_recovery_failed" }))
      .finally(() => {
        this.pending = undefined;
      });
  }
  async stop() {
    this.stopped = true;
    await this.pending;
  }
  async poll() {
    const config = structuredClone(this.host.config),
      fingerprint = digest(config);
    for (const b of this.host.bindings()) {
      if (!b.allowSend || b.threadId !== null) continue;
      if (this.stopped || !this.ready()) return;
      const key = `message-recovery:${b.id}`;
      const row = this.host.store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(key) as { value: string } | undefined;
      // First enablement starts now; never replay a newly authorized chat's past.
      const cursor: {
        since: number;
        floor?: number;
        until?: number;
        page?: string;
      } = row ? JSON.parse(row.value) : { since: Date.now() };
      cursor.floor ??= cursor.since;
      if (!row) {
        this.save(key, cursor);
        continue;
      }
      const until = cursor.until ?? Date.now() - 2000;
      if (until <= cursor.since) continue;
      let page: HistoryPage;
      try {
        page = await this.history(b, cursor.since, until, cursor.page);
      } catch {
        this.log({
          kind: "message_recovery_failed",
          botId: b.botId,
          bindingId: b.id,
        });
        continue;
      }
      if (
        this.stopped ||
        !this.ready() ||
        digest(this.host.config) !== fingerprint
      )
        return;
      const bot = config.bots.find((bot) => bot.id === b.botId)!;
      for (const m of page.items ?? []) {
        const time = Number(m.create_time);
        if (
          !Number.isFinite(time) ||
          time < cursor.since ||
          time > until ||
          m.chat_id !== b.chatId ||
          m.deleted ||
          m.updated ||
          !["text", "post", "image"].includes(m.msg_type) ||
          m.thread_id ||
          m.root_id ||
          m.upper_message_id ||
          (m.mentions?.length &&
            (!Array.isArray(m.mentions) ||
              m.mentions.some(
                (mention: any) =>
                  mention.id_type !== "open_id" ||
                  !/^ou_[A-Za-z0-9_-]{1,190}$/.test(mention.id ?? "") ||
                  typeof mention.name !== "string" ||
                  !/^@_user_\d+$/.test(mention.key ?? ""),
              ))) ||
          m.sender?.sender_type !== "user" ||
          m.sender?.id_type !== "open_id" ||
          m.sender?.tenant_key !== bot.tenantKey ||
          !isUserAllowed(bot, m.sender.id, b) ||
          typeof m.message_id !== "string"
        )
          continue;
        if (
          this.host.store.db
            .prepare("SELECT 1 FROM inbox WHERE scope=? AND id=?")
            .get(`native:${b.botId}`, m.message_id)
        )
          continue;
        let content: ReturnType<typeof messageContent>;
        try {
          content = messageContent(m.msg_type, m.body?.content);
        } catch {
          continue;
        }
        const text = content.text;
        if (/@_all|<at\b/.test(text)) continue;
        const result = this.receive({
          botId: b.botId,
          nativeId: m.message_id,
          tenantKey: m.sender.tenant_key,
          chatId: b.chatId,
          threadId: null,
          senderId: m.sender.id,
          senderType: "human",
          text,
          imageKeys: content.imageKeys.length ? content.imageKeys : undefined,
          mentions: (m.mentions ?? []).map((mention: any) => mention.id),
          ...(m.mentions?.length
            ? {
                userMentions: m.mentions.map((mention: any) => ({
                  key: mention.key,
                  openId: mention.id,
                  name: mention.name.slice(0, 100),
                })),
              }
            : {}),
          mentionAll: false,
          chatType: "p2p",
        });
        this.log({
          kind: "message_recovered",
          botId: b.botId,
          messageId: m.message_id,
          status: result.status,
        });
        if (
          ["queue_full", "connection_not_ready", "stopping"].includes(
            result.status,
          )
        )
          return;
      }
      if (page.has_more) {
        if (!page.page_token) throw new Error("history_pagination_missing");
        this.save(key, { ...cursor, until, page: page.page_token });
      } else
        this.save(key, {
          since: Math.max(cursor.floor, until - 30000),
          floor: cursor.floor,
        });
    }
  }
  private save(key: string, value: object) {
    this.host.store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
}

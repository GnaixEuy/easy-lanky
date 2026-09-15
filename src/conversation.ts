import { randomUUID } from "node:crypto";
import type { Config, Binding, Bot } from "./config.js";
import { digest, type Run, type Delivery } from "./contracts.js";
import type { Store } from "./store.js";
export type ConversationRef = { scope: string; epoch: string };
type Turn = {
  id: string;
  text: string;
  at: number;
  reply?: string;
  source: string;
};
export type ChatContext = {
  source: "feishu_conversation";
  earliestRecordedAt?: number;
  earliestUserMessage?: string;
  totalPriorTurns: number;
  omittedTurns: number;
  truncated: boolean;
  turns: Turn[];
};
export class ConversationStore {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_turns(
      seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, epoch TEXT NOT NULL,
      id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(scope,epoch,id));
      CREATE INDEX IF NOT EXISTS conversation_scope ON conversation_turns(scope,epoch,seq);`);
  }
  current(
    config: Config,
    binding: Binding,
    bot: Bot,
    user: string,
  ): ConversationRef {
    const project = config.projects.find((p) => p.id === binding.projectId);
    if (!project || !binding.allowedUsers.includes(user))
      throw new Error("conversation_scope_rejected");
    const scope = digest([
      bot.id,
      bot.appId,
      bot.tenantKey,
      bot.selfOpenId,
      binding.chatId,
      binding.threadId,
      user,
      bot.agentId,
      project.id,
      project.root,
    ]);
    const key = `conversation_epoch:${scope}`;
    const epoch =
      (
        this.store.db
          .prepare("SELECT value FROM meta WHERE key=?")
          .get(key) as any
      )?.value || "initial";
    return { scope, epoch };
  }
  reset(ref: ConversationRef) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run(`conversation_epoch:${ref.scope}`, randomUUID());
  }
  user(
    ref: ConversationRef,
    id: string,
    text: string,
    at: number,
    source = "host",
  ) {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO conversation_turns(scope,epoch,id,data) VALUES (?,?,?,?)",
      )
      .run(ref.scope, ref.epoch, id, JSON.stringify({ id, text, at, source }));
  }
  reply(ref: ConversationRef, id: string, text: string) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM conversation_turns WHERE scope=? AND epoch=? AND id=?",
      )
      .get(ref.scope, ref.epoch, id) as any;
    if (row)
      this.store.db
        .prepare(
          "UPDATE conversation_turns SET data=? WHERE scope=? AND epoch=? AND id=?",
        )
        .run(
          JSON.stringify({ ...JSON.parse(row.data), reply: text }),
          ref.scope,
          ref.epoch,
          id,
        );
  }
  delivered(delivery: Delivery) {
    if (delivery.status !== "result" || !delivery.runId || delivery.envelope)
      return;
    const run = this.store.get(delivery.runId);
    if (run?.conversation)
      this.reply(
        run.conversation,
        run.nativeId,
        this.store
          .deliveries()
          .filter(
            (d) =>
              d.state === "sent" &&
              d.data.runId === run.id &&
              d.data.status === "result" &&
              !d.data.envelope,
          )
          .map((d) => d.data.text)
          .join("\n"),
      );
  }
  context(ref: ConversationRef, beforeId?: string): ChatContext {
    const current = beforeId
      ? (this.store.db
          .prepare(
            "SELECT seq FROM conversation_turns WHERE scope=? AND epoch=? AND id=?",
          )
          .get(ref.scope, ref.epoch, beforeId) as any)
      : undefined;
    const limit = current?.seq ?? Number.MAX_SAFE_INTEGER;
    const count = (
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM conversation_turns WHERE scope=? AND epoch=? AND seq<?",
        )
        .get(ref.scope, ref.epoch, limit) as any
    ).n as number;
    const head = this.store.db
      .prepare(
        "SELECT seq,data FROM conversation_turns WHERE scope=? AND epoch=? AND seq<? ORDER BY seq LIMIT 1",
      )
      .get(ref.scope, ref.epoch, limit) as any;
    const tail = this.store.db
      .prepare(
        "SELECT seq,data FROM conversation_turns WHERE scope=? AND epoch=? AND seq<? ORDER BY seq DESC LIMIT 30",
      )
      .all(ref.scope, ref.epoch, limit) as any[];
    const picked = new Map<number, Turn>();
    let remaining = 24000,
      truncated = false;
    const add = (row: any) => {
      if (!row || picked.has(row.seq) || remaining < 300) return;
      const original: Turn = JSON.parse(row.data);
      const text = original.text.slice(0, Math.min(6000, remaining));
      remaining -= text.length;
      const reply = original.reply?.slice(0, Math.min(6000, remaining));
      remaining -= reply?.length || 0;
      if (text !== original.text || reply !== original.reply) truncated = true;
      picked.set(row.seq, { ...original, text, reply });
    };
    add(head);
    for (const row of tail) add(row);
    const turns = [...picked].sort(([a], [b]) => a - b).map(([, v]) => v);
    const first: Turn | undefined = head ? JSON.parse(head.data) : undefined;
    return {
      source: "feishu_conversation",
      earliestRecordedAt: first?.at,
      earliestUserMessage: first?.text.slice(0, 2000),
      totalPriorTurns: count,
      omittedTurns: count - turns.length,
      truncated: truncated || count > turns.length,
      turns,
    };
  }
  ready(run: Run) {
    if (!run.conversation) return true;
    const earlier = this.store
      .runs()
      .slice(
        0,
        this.store.runs().findIndex((r) => r.id === run.id),
      )
      .filter(
        (r) =>
          r.conversation?.scope === run.conversation!.scope &&
          r.conversation?.epoch === run.conversation!.epoch,
      );
    if (earlier.some((r) => ["queued", "running", "waiting"].includes(r.state)))
      return false;
    const ids = new Set(earlier.map((r) => r.id));
    return !this.store
      .deliveries()
      .some(
        (d) =>
          d.data.runId &&
          ids.has(d.data.runId) &&
          ["pending", "sending"].includes(d.state),
      );
  }
}

// Called explicitly by the local operator; historical text is context, never a Run.
export function importPrivateHistory(
  history: ConversationStore,
  ref: ConversationRef,
  binding: Binding,
  bot: Bot,
  user: string,
  items: any[],
) {
  if (
    binding.threadId !== null ||
    !binding.allowedUsers.includes(user) ||
    !binding.allowSend
  )
    throw new Error("conversation_scope_rejected");
  const safe = items
    .filter(
      (m) =>
        m.chat_id === binding.chatId &&
        m.msg_type === "text" &&
        !m.deleted &&
        !m.updated &&
        !m.thread_id &&
        !m.upper_message_id &&
        m.sender?.tenant_key === bot.tenantKey &&
        typeof m.message_id === "string" &&
        Number.isFinite(Number(m.create_time)),
    )
    .sort((a, b) => Number(a.create_time) - Number(b.create_time));
  const text = (m: any): string | undefined => {
    try {
      const value = JSON.parse(m.body?.content).text;
      return typeof value === "string" && value.length <= 16000
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const own = safe.filter(
    (m) =>
      m.sender?.sender_type === "user" &&
      m.sender.id_type === "open_id" &&
      m.sender.id === user &&
      text(m) !== undefined,
  );
  history.store.transaction(() => {
    for (const m of own)
      history.user(
        ref,
        m.message_id,
        text(m)!,
        Number(m.create_time),
        "platform_history",
      );
    const ids = new Set(own.map((m) => m.message_id));
    for (const m of safe)
      if (
        m.sender?.sender_type === "app" &&
        m.sender.id_type === "app_id" &&
        m.sender.id === bot.appId &&
        ids.has(m.parent_id) &&
        text(m) !== undefined &&
        !/^\[(accepted|result)\]/.test(text(m)!)
      )
        history.reply(ref, m.parent_id, text(m)!);
  });
  return own.length;
}

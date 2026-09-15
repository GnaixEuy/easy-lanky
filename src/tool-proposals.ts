import { randomBytes } from "node:crypto";
import { digest, type Run } from "./contracts.js";
import type { Binding, Bot } from "./config.js";
import type { Store } from "./store.js";
import type { LarkToolRequest, LarkToolResult } from "./lark-tools.js";
type Proposal = {
  id: string;
  owner: string;
  identity: string;
  conversation: Run["conversation"];
  request: LarkToolRequest;
  preview: string;
  expiresAt: number;
  state: "pending" | "executing" | "completed" | "failed" | "cancelled";
  result?: LarkToolResult;
};
const identity = (b: Binding, bot: Bot) =>
  digest([
    b.id,
    b.chatId,
    b.threadId,
    b.projectId,
    bot.id,
    bot.appId,
    bot.tenantKey,
    bot.selfOpenId,
  ]);
export class ToolProposals {
  constructor(readonly store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS tool_proposals(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
  }
  private save(p: Proposal) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO tool_proposals VALUES (?,?)")
      .run(p.id, JSON.stringify(p));
  }
  private get(id: string): Proposal | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM tool_proposals WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  propose(
    run: Run,
    b: Binding,
    bot: Bot,
    request: LarkToolRequest,
    result: LarkToolResult,
  ) {
    // A shortened dry-run cannot establish the complete request the user approved.
    if (result.truncated || result.output.length > 7500)
      return "操作预览过长，尚未执行。请缩小本次修改范围后重试。";
    const p: Proposal = {
      id: randomBytes(6).toString("hex"),
      owner: run.owner,
      identity: identity(b, bot),
      conversation: run.conversation,
      request,
      preview: result.output,
      expiresAt: Date.now() + 1800000,
      state: "pending",
    };
    this.save(p);
    this.store.audit("tool_proposed", run.id, p.id);
    return `待确认的飞书操作（尚未执行）：\n${JSON.stringify(request.argv)}\n\n平台请求预览：\n${p.preview}\n\n确认执行请回复 /approve-tool ${p.id}\n取消请回复 /cancel-tool ${p.id}\n确认有效期 30 分钟，仅在本用户、本对话有效。`;
  }
  claim(id: string, run: Run, b: Binding, bot: Bot) {
    const p = this.get(id);
    if (
      !p ||
      p.owner !== run.owner ||
      p.identity !== identity(b, bot) ||
      digest(p.conversation) !== digest(run.conversation)
    )
      throw new Error("tool_confirmation_wrong_conversation");
    if (p.state !== "pending")
      throw new Error("tool_already_processed_check_receipt");
    if (p.expiresAt < Date.now()) throw new Error("tool_confirmation_expired");
    p.state = "executing";
    this.save(p);
    this.store.audit("tool_confirmed", run.id, id);
    return p.request;
  }
  cancel(id: string, run: Run, b: Binding, bot: Bot) {
    this.claim(id, run, b, bot);
    const p = this.get(id)!;
    p.state = "cancelled";
    this.save(p);
  }
  finish(id: string, result: LarkToolResult) {
    const p = this.get(id)!;
    p.state = result.ok ? "completed" : "failed";
    p.result = result;
    this.save(p);
  }
}

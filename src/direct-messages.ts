import { randomBytes, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { ContactResult, Contact } from "./contacts.js";
import type { Run, Delivery, Inbound } from "./contracts.js";
import { digest } from "./contracts.js";
import type { Binding, Bot } from "./config.js";
type Proposal = {
  id: string;
  runId: string;
  owner: string;
  bindingId: string;
  identity: string;
  conversation: Run["conversation"];
  expiresAt: number;
  text: string;
  contacts: Contact[];
  state: "pending" | "confirmed" | "cancelled";
  deliveryId?: string;
  selected?: number;
};
function identity(b: Binding, bot: Bot) {
  return digest([
    bot.id,
    bot.appId,
    bot.tenantKey,
    bot.selfOpenId,
    b.id,
    b.chatId,
    b.threadId,
    b.projectId,
  ]);
}
export class DirectMessages {
  constructor(readonly store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS direct_proposals(id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  private get(id: string): Proposal | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM direct_proposals WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(p: Proposal) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO direct_proposals VALUES (?,?)")
      .run(p.id, JSON.stringify(p));
  }
  propose(run: Run, b: Binding, bot: Bot, result: ContactResult, text: string) {
    if (!result.contacts.length)
      return "在此机器人可见的通讯录中未找到收件人。请使用飞书原生 @ 选择收件人，或提供完整姓名/该应用下的 open_id，并检查飞书应用的通讯录可见范围；尚未发送。";
    const p: Proposal = {
      id: randomBytes(6).toString("hex"),
      runId: run.id,
      owner: run.owner,
      bindingId: b.id,
      identity: identity(b, bot),
      conversation: run.conversation,
      expiresAt: Date.now() + 30 * 60 * 1000,
      text,
      contacts: result.contacts,
      state: "pending",
    };
    this.save(p);
    if (result.contacts.length === 1 && !result.incomplete) {
      this.submit(p, b, bot, run.nativeId, 0, "explicit_request");
      return "";
    }
    return `待发送内容：\n${text}\n\n收件人：\n${p.contacts.map((c, i) => `${i + 1}. ${c.name}${c.department ? `（${c.department}）` : ""} · ${c.openId}`).join("\n")}\n\n请核对收件人和正文，回复 /send ${p.id} 序号 确认发送（例如 /send ${p.id} 1）。30 分钟内有效；取消用 /cancel-send ${p.id}。${result.incomplete ? "\n通讯录结果不完整；没有列出目标时请缩小查询范围。" : ""}`;
  }
  command(
    prompt: string,
    b: Binding,
    bot: Bot,
    event: Inbound,
    conversation: Run["conversation"],
  ): string | undefined {
    if (!/^\/(send|cancel-send)(?:\s|$)/.test(prompt)) return;
    const match = prompt.match(
      /^\/(send|cancel-send)\s+([a-f0-9]{12})(?:\s+(\d{1,2}))?$/,
    );
    if (!match)
      return "使用 /send 确认码 序号，或 /cancel-send 确认码；确认码来自待发送预览。";
    const p = this.get(match[2]);
    if (
      !p ||
      p.owner !== event.senderId ||
      p.bindingId !== b.id ||
      p.identity !== identity(b, bot) ||
      digest(p.conversation) !== digest(conversation)
    )
      return "此发送请求不属于当前用户或会话。";
    if (p.state !== "pending")
      return p.state === "confirmed"
        ? "该请求已提交，不会重复发送。"
        : "该请求已取消。";
    if (Date.now() > p.expiresAt) return "发送请求已过期，请重新提出发送要求。";
    if (match[1] === "cancel-send") {
      p.state = "cancelled";
      this.save(p);
      return "已取消，未发送。";
    }
    const selected = Number(match[3]) - 1;
    if (
      !Number.isInteger(selected) ||
      selected < 0 ||
      selected >= p.contacts.length
    )
      return "请填写预览中的有效收件人序号。";
    if (!b.allowSend) return "当前会话的发信权限已关闭，未发送。";
    this.submit(p, b, bot, event.nativeId, selected, "selection");
    return "";
  }
  private submit(
    p: Proposal,
    b: Binding,
    bot: Bot,
    replyTo: string,
    selected: number,
    authorization: "explicit_request" | "selection",
  ) {
    if (!b.allowSend || !b.allowedUsers.includes(p.owner))
      throw new Error("direct_send_not_authorized");
    p.state = "confirmed";
    p.selected = selected;
    p.deliveryId = randomUUID();
    this.save(p);
    const contact = p.contacts[selected];
    this.store.enqueue({
      id: p.deliveryId,
      runId: p.runId,
      botId: bot.id,
      chatId: b.chatId,
      threadId: b.threadId,
      replyTo,
      mode: "direct",
      direct: { requestId: p.id, openId: contact.openId, name: contact.name },
      text: p.text,
    });
    this.store.audit(
      authorization === "explicit_request"
        ? "direct_requested"
        : "direct_confirmed",
      p.runId,
      p.id,
    );
  }
  authorized(
    d: Delivery,
    b: Binding,
    bot: Bot,
    conversation: Run["conversation"],
  ) {
    const p = d.direct && this.get(d.direct.requestId);
    const run = p && this.store.get(p.runId);
    return !!(
      p &&
      run &&
      run.origin === "human" &&
      !run.local &&
      p.state === "confirmed" &&
      p.deliveryId === d.id &&
      p.runId === d.runId &&
      p.text === d.text &&
      p.contacts[p.selected!]?.openId === d.direct?.openId &&
      p.identity === identity(b, bot) &&
      b.allowSend &&
      b.allowedUsers.includes(p.owner) &&
      digest(p.conversation) === digest(conversation)
    );
  }
}

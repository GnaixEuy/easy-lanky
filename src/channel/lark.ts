import { findContacts, listContacts } from "../contacts.js";
import {
  LarkToolRunner,
  type LarkToolRequest,
  type LarkToolContext,
  type LarkToolResult,
} from "../lark-tools.js";
import { createLarkApi } from "../bot-setup.js";
import { DeliveryError } from "../delivery-error.js";
import {
  createLarkChannel,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuite/channel";
import type { Config, Bot } from "../config.js";
function sendError(value: any): DeliveryError {
  const code = Number.isInteger(value?.code) ? value.code : undefined;
  const known: Record<number, [string, string]> = {
    230013: [
      "lark_recipient_unavailable",
      "发送失败：收件人不在此机器人的应用可用范围内。请管理员在飞书应用的可用范围中加入收件人；通讯录可见不代表可以发送消息。",
    ],
    230053: [
      "lark_recipient_opted_out",
      "发送失败：收件人已设置不再接收此机器人的消息。",
    ],
    99991672: [
      "lark_send_permission_required",
      "发送失败：飞书应用缺少发送消息所需的接口权限。请管理员检查应用权限。",
    ],
  };
  const failure = code === undefined ? undefined : known[code];
  return failure
    ? new DeliveryError("failed", failure[0], code, failure[1])
    : new DeliveryError("unknown", "lark_send_unconfirmed", code);
}
import {
  wireText,
  type Delivery,
  type Inbound,
  type Transport,
} from "../contracts.js";
export function normalizeInbound(
  bot: Bot,
  msg: NormalizedMessage,
): Inbound | null {
  if (msg.rawContentType !== "text") return null;
  const raw = msg.raw as
    | { sender?: { tenant_key?: string }; message?: { content?: string } }
    | undefined;
  // Do not invent tenant attribution if the platform payload omitted it.
  if (!raw?.sender?.tenant_key) return null;
  let text: string;
  try {
    text = JSON.parse(raw.message?.content ?? "").text;
    if (typeof text !== "string") return null;
  } catch {
    return null;
  }
  return {
    botId: bot.id,
    nativeId: msg.messageId,
    tenantKey: raw.sender.tenant_key,
    chatId: msg.chatId,
    threadId: msg.threadId ?? null,
    senderId: msg.senderId,
    senderType:
      msg.senderType === "user"
        ? "human"
        : ["bot", "app"].includes(msg.senderType ?? "")
          ? "agent"
          : "unknown",
    text,
    mentions: msg.mentions.flatMap((m) => (m.openId ? [m.openId] : [])),
    userMentions: msg.mentions.flatMap((m) =>
      m.openId &&
      m.name &&
      m.isBot !== true &&
      m.openId !== bot.selfOpenId &&
      /^ou_[A-Za-z0-9_-]{1,190}$/.test(m.openId)
        ? [{ key: m.key, openId: m.openId, name: m.name.slice(0, 100) }]
        : [],
    ),
    mentionAll: msg.mentionAll,
    chatType: msg.chatType,
  };
}
export class LarkTransport implements Transport {
  readonly channels = new Map<string, LarkChannel>();
  private health = new Map<
    string,
    {
      verified: boolean;
      failed: boolean;
      connectedAt?: number;
      lastRawAt?: number;
      lastMessageAt?: number;
      lastErrorAt?: number;
    }
  >();
  private reactions = new Map<
    string,
    { botId: string; messageId: string; reactionId: string }
  >();
  constructor(
    readonly config: Config,
    readonly inbound: (event: Inbound) => void,
    readonly log: (event: object) => void,
    private readonly createChannel = createLarkChannel,
  ) {}
  async connect() {
    try {
      for (const bot of this.config.bots) {
        const secret = process.env[bot.appSecretEnv];
        if (!secret) throw new Error(`missing_secret:${bot.appSecretEnv}`);
        const health = { verified: false, failed: false } as NonNullable<
          ReturnType<typeof this.health.get>
        >;
        this.health.set(bot.id, health);
        const current = () => this.health.get(bot.id) === health;
        const channel = this.createChannel({
          appId: bot.appId,
          appSecret: secret,
          domain:
            bot.tenant === "lark"
              ? "https://open.larksuite.com"
              : "https://open.feishu.cn",
          source: "easy-larky",
          includeRawEvent: true,
          policy: {
            dmMode: "open",
            requireMention: false,
            respondToMentionAll: false,
          },
          safety: {
            chatQueue: { enabled: false },
            // Host Inbox owns message identity and deduplication. Never merge
            // distinct platform messages before they reach that boundary.
            batch: { text: { delayMs: 0 } },
          },
          outbound: { retry: { maxAttempts: 1 } },
          httpTimeoutMs: 15000,
          connectTimeoutMs: 15000,
          handshakeTimeoutMs: 15000,
          keepalive: {
            enabled: true,
            intervalMs: 15000,
            onUnrecoverable: () => {
              if (!current()) return;
              health.failed = true;
              health.lastErrorAt = Date.now();
              this.log({ kind: "channel_reconnect_failed", botId: bot.id });
            },
          },
          respectProxyEnv: true,
          logger: {
            debug: () => {},
            info: () => {},
            warn: () => this.log({ kind: "channel_warning", botId: bot.id }),
            error: () => this.log({ kind: "channel_error", botId: bot.id }),
            trace: () => {},
          },
        });
        this.channels.set(bot.id, channel);
        channel.onRawEvent("im.message.receive_v1", () => {
          if (!current()) return;
          health.lastRawAt = Date.now();
          if (health.verified) health.failed = false;
          this.log({ kind: "platform_message_received", botId: bot.id });
        });
        channel.on({
          reject: (event) =>
            this.log({
              kind: "channel_message_rejected",
              botId: bot.id,
              reason: event.reason,
            }),
          message: (msg) => {
            if (!current() || !health.verified) return;
            const event = normalizeInbound(bot, msg);
            if (event) {
              health.lastMessageAt = Date.now();
              health.failed = false;
              this.inbound(event);
            } else
              this.log({
                kind: "unrecognized_platform_message",
                botId: bot.id,
              });
          },
          error: () => {
            if (!current()) return;
            health.lastErrorAt = Date.now();
            this.log({ kind: "channel_error", botId: bot.id });
          },
        });
        await channel.connect();
        if (channel.botIdentity?.openId !== bot.selfOpenId)
          throw new Error(`bot_identity_mismatch:${bot.id}`);
        health.verified = true;
        health.connectedAt = Date.now();
        this.log({ kind: "channel_connected", botId: bot.id });
      }
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }
  async findContacts(botId: string, query: string) {
    const bot = this.config.bots.find((b) => b.id === botId);
    if (!bot || !this.channels.has(botId))
      throw new Error("channel_not_connected");
    const call = await createLarkApi(
      bot.tenant,
      bot.appId,
      process.env[bot.appSecretEnv]!,
    );
    return findContacts(
      (route) => call(route, "directory_lookup_failed"),
      query,
    );
  }
  async runTool(
    botId: string,
    request: LarkToolRequest,
    context: LarkToolContext,
  ): Promise<LarkToolResult> {
    const bot = this.config.bots.find((b) => b.id === botId);
    if (!bot || !this.channels.has(botId))
      return { ok: false, output: "channel_not_connected" };
    if (request.argv[0] !== "directory")
      return new LarkToolRunner(this.config.stateDir).execute(
        bot,
        request,
        context,
      );
    try {
      const args = request.argv;
      if (args[1] !== "list" || args.length > 6 || args.length % 2 !== 0)
        throw new Error("use_directory_list_with_query_offset");
      let query = "",
        offset = 0;
      const seen = new Set<string>();
      for (let i = 2; i < args.length; i += 2) {
        if (seen.has(args[i])) throw new Error("invalid_directory_arguments");
        seen.add(args[i]);
        if (args[i] === "--query") query = args[i + 1];
        else if (args[i] === "--offset" && /^\d+$/.test(args[i + 1]))
          offset = Number(args[i + 1]);
        else throw new Error("invalid_directory_arguments");
      }
      if (context.signal.aborted) throw new Error("tool_cancelled");
      const call = await createLarkApi(
        bot.tenant,
        bot.appId,
        process.env[bot.appSecretEnv]!,
      );
      const result = await listContacts(
        async (route) => {
          if (context.signal.aborted) throw new Error("tool_cancelled");
          return call(route, "directory_lookup_failed");
        },
        query,
        offset,
      );
      if (context.signal.aborted) throw new Error("tool_cancelled");
      return { ok: true, output: JSON.stringify(result) };
    } catch (e) {
      return {
        ok: false,
        output: e instanceof Error ? e.message : "directory_lookup_failed",
      };
    }
  }
  async send(d: Delivery): Promise<{ messageId: string }> {
    const channel = this.channels.get(d.botId);
    if (!channel) throw new Error("channel_not_connected");
    const humanStatus = !d.envelope && d.status;
    const key = JSON.stringify([d.botId, d.replyTo]);
    if (humanStatus === "accepted") {
      try {
        if (!this.reactions.has(key)) {
          const reactionId = await channel.addReaction(d.replyTo, "Typing");
          this.reactions.set(key, {
            botId: d.botId,
            messageId: d.replyTo,
            reactionId,
          });
        }
        // The receipt points to the original message bearing the reaction; no new chat message is sent.
        return { messageId: d.replyTo };
      } catch {
        this.log({ kind: "typing_reaction_failed", botId: d.botId });
        // Preserve visible acknowledgement if this application's reaction permission is missing.
      }
    }
    try {
      // Direct official SDK call supplies stable provider UUID. No blind retry after an ambiguous response.
      if (
        d.mode === "message" &&
        (d.threadId !== null || d.envelope || d.status !== "result")
      )
        throw new Error("invalid_standalone_message");
      if (
        d.mode === "direct" &&
        (!d.direct ||
          !/^ou_[A-Za-z0-9_-]{1,190}$/.test(d.direct.openId) ||
          d.envelope ||
          d.status)
      )
        throw new Error("invalid_direct_message");
      const response =
        d.mode === "direct"
          ? await channel.rawClient.im.message.create({
              params: { receive_id_type: "open_id" },
              data: {
                receive_id: d.direct!.openId,
                content: JSON.stringify({ text: wireText(d) }),
                msg_type: "text",
                uuid: d.id,
              },
            })
          : d.mode === "message"
            ? await channel.rawClient.im.message.create({
                params: { receive_id_type: "chat_id" },
                data: {
                  receive_id: d.chatId,
                  content: JSON.stringify({ text: wireText(d) }),
                  msg_type: "text",
                  uuid: d.id,
                },
              })
            : await channel.rawClient.im.message.reply({
                path: { message_id: d.replyTo },
                data: {
                  content: JSON.stringify({ text: wireText(d) }),
                  msg_type: "text",
                  reply_in_thread: d.threadId !== null,
                  uuid: d.id,
                },
              });
      const messageId = response.data?.message_id;
      if (response.code !== 0 || !messageId) throw sendError(response);
      return { messageId };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      if (
        error instanceof Error &&
        ["invalid_direct_message", "invalid_standalone_message"].includes(
          error.message,
        )
      )
        throw error;
      // The official SDK rejects non-2xx responses with Axios response.data.
      // Transport errors and unrecognized provider failures remain uncertain.
      throw sendError((error as any)?.response?.data);
    } finally {
      if (humanStatus && humanStatus !== "accepted")
        await this.clearReaction(d.botId, d.replyTo);
    }
  }
  private async clearReaction(botId: string, messageId: string) {
    const key = JSON.stringify([botId, messageId]);
    const reaction = this.reactions.get(key);
    const channel = this.channels.get(botId);
    if (!channel) return;
    try {
      if (reaction)
        await channel.removeReaction(messageId, reaction.reactionId);
      else await channel.removeReactionByEmoji(messageId, "Typing");
      this.reactions.delete(key);
    } catch {
      this.log({ kind: "typing_cleanup_failed", botId });
    }
  }

  async history(
    binding: Config["bindings"][number],
    since: number,
    until: number,
    page?: string,
  ) {
    const channel = this.channels.get(binding.botId);
    if (!channel) throw new Error("channel_not_connected");
    const chat = await channel.rawClient.im.chat.get({
      path: { chat_id: binding.chatId },
    });
    if (chat.code !== 0) throw new Error("history_chat_unverified");
    if (chat.data?.chat_mode !== "p2p") return { items: [] };
    const result = await channel.rawClient.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: binding.chatId,
        start_time: String(Math.floor(since / 1000)),
        end_time: String(Math.ceil(until / 1000)),
        sort_type: "ByCreateTimeAsc",
        page_size: 50,
        ...(page ? { page_token: page } : {}),
      },
    });
    if (result.code !== 0 || !result.data)
      throw new Error("history_fetch_failed");
    return result.data;
  }
  status() {
    return [...this.channels].map(([botId, c]) => {
      const health = this.health.get(botId);
      return {
        botId,
        connection: health?.failed
          ? "failed"
          : health?.verified
            ? c.getConnectionStatus()?.state
            : "connecting",
        connectedAt: health?.connectedAt,
        lastRawAt: health?.lastRawAt,
        lastMessageAt: health?.lastMessageAt,
        lastErrorAt: health?.lastErrorAt,
      };
    });
  }
  async disconnect() {
    // Late callbacks from a closed channel must not deliver into the next one.
    this.health.clear();
    await Promise.allSettled(
      [...this.reactions.values()].map((r) =>
        this.clearReaction(r.botId, r.messageId),
      ),
    );
    await Promise.allSettled(
      [...this.channels.values()].map((c) => c.disconnect()),
    );
    this.channels.clear();
  }
}

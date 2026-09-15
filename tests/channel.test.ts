import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInbound } from "../src/channel/lark.js";
import type { Bot } from "../src/config.js";
import type { NormalizedMessage } from "@larksuite/channel";
const bot: Bot = {
  id: "a",
  agentId: "chatgpt",
  appId: "app_a",
  tenant: "feishu",
  tenantKey: "tenant",
  appType: "custom",
  appSecretEnv: "SECRET",
  selfOpenId: "oa",
  peers: {},
};
function message(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    messageId: "m1",
    chatId: "chat",
    chatType: "group",
    senderId: "ob",
    senderType: "app",
    content: "display only",
    rawContentType: "text",
    resources: [],
    mentions: [{ key: "@_user_1", openId: "oa" }],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1,
    raw: {
      sender: { tenant_key: "tenant" },
      message: {
        content: JSON.stringify({ text: "@_user_1 [easy-larky:v1]\n{}" }),
      },
    },
    ...overrides,
  };
}
test("normalization uses platform sender and real mentions; group root is not thread", () => {
  const result = normalizeInbound(bot, message({ rootId: "parent" }))!;
  assert.equal(result.senderType, "agent");
  assert.equal(result.threadId, null);
  assert.deepEqual(result.mentions, ["oa"]);
  assert.ok(result.text.includes("[easy-larky:v1]"));
  assert.equal(
    normalizeInbound(bot, message({ threadId: "topic" }))?.threadId,
    "topic",
  );
});
test("missing tenant/raw body or unsupported content fails closed", () => {
  assert.equal(normalizeInbound(bot, message({ raw: undefined })), null);
  assert.equal(
    normalizeInbound(bot, message({ rawContentType: "post" })),
    null,
  );
  assert.equal(
    normalizeInbound(
      bot,
      message({
        raw: {
          sender: { tenant_key: "tenant" },
          message: { content: "not-json" },
        },
      }),
    ),
    null,
  );
});

// Exercise the actual transport presentation layer with the official channel surface mocked.
import { LarkTransport } from "../src/channel/lark.js";
import type { Config } from "../src/config.js";
import type { Delivery } from "../src/contracts.js";
function reactionTransport() {
  const calls: string[] = [];
  const texts: string[] = [];
  const channel = {
    addReaction: async (_message: string, emoji: string) => {
      calls.push(`add:${emoji}`);
      return "reaction";
    },
    removeReaction: async () => {
      calls.push("remove");
    },
    removeReactionByEmoji: async () => {
      calls.push("recover-remove");
      return true;
    },
    disconnect: async () => {},
    rawClient: {
      im: {
        message: {
          reply: async (args: any) => {
            texts.push(JSON.parse(args.data.content).text);
            return { code: 0, data: { message_id: "reply" } };
          },
        },
      },
    },
  };
  const transport = new LarkTransport(
    {} as Config,
    () => {},
    () => {},
  );
  transport.channels.set("a", channel as any);
  const delivery: Delivery = {
    id: "d1",
    botId: "a",
    chatId: "chat",
    threadId: null,
    replyTo: "original",
    text: "已接收任务，等待执行。",
    status: "accepted",
  };
  return { transport, channel, calls, texts, delivery };
}
test("human acknowledgement reacts once, final reply is plain text and clears typing", async () => {
  const x = reactionTransport();
  await x.transport.send(x.delivery);
  await x.transport.send(x.delivery);
  assert.deepEqual(x.calls, ["add:Typing"]);
  assert.equal(x.texts.length, 0);
  await x.transport.send({
    ...x.delivery,
    id: "d2",
    status: "result",
    text: "你好！",
  });
  assert.deepEqual(x.texts, ["你好！"]);
  assert.deepEqual(x.calls, ["add:Typing", "remove"]);
});
test("reaction failure falls back to acknowledgement without blocking final reply", async () => {
  const x = reactionTransport();
  x.channel.addReaction = async () => {
    throw new Error("permission");
  };
  await x.transport.send(x.delivery);
  await x.transport.send({ ...x.delivery, status: "failed", text: "任务失败" });
  assert.deepEqual(x.texts, ["已接收任务，等待执行。", "任务失败"]);
});
test("send failure and cancellation remove typing; disconnect cleans outstanding reactions", async () => {
  const x = reactionTransport();
  await x.transport.send(x.delivery);
  x.channel.rawClient.im.message.reply = async () => {
    throw new Error("network");
  };
  await assert.rejects(
    x.transport.send({ ...x.delivery, status: "cancelled" }),
  );
  assert.equal(x.calls.at(-1), "remove");
  await x.transport.send({ ...x.delivery, replyTo: "other" });
  await x.transport.disconnect();
  assert.equal(x.calls.at(-1), "remove");
});
test("agent protocol acknowledgement remains a message, never a reaction", async () => {
  const x = reactionTransport();
  await x.transport.send({
    ...x.delivery,
    envelope: {
      version: 1,
      id: "e",
      taskId: "task",
      rootTaskId: "task",
      from: "chatgpt",
      to: "grok",
      projectId: "p",
      kind: "accepted",
      hop: 1,
      text: "ok",
    },
  });
  assert.equal(x.calls.length, 0);
  assert.ok(x.texts[0].includes("[easy-larky:v1]"));
});

function connectionTransport(t: any) {
  const previous = process.env.EASY_LARKY_CHANNEL_TEST_SECRET;
  process.env.EASY_LARKY_CHANNEL_TEST_SECRET = "test-only";
  t.after(() => {
    if (previous === undefined)
      delete process.env.EASY_LARKY_CHANNEL_TEST_SECRET;
    else process.env.EASY_LARKY_CHANNEL_TEST_SECRET = previous;
  });
  const instances: any[] = [];
  const received: any[] = [];
  const logs: object[] = [];
  const transport = new LarkTransport(
    {
      bots: [{ ...bot, appSecretEnv: "EASY_LARKY_CHANNEL_TEST_SECRET" }],
    } as Config,
    (e) => received.push(e),
    (e) => logs.push(e),
    ((options: any) => {
      const c = {
        options,
        handlers: {} as any,
        raw: () => {},
        botIdentity: { openId: bot.selfOpenId },
        onRawEvent: (_type: string, handler: any) => {
          c.raw = handler;
        },
        on: (handlers: any) => {
          c.handlers = handlers;
        },
        connect: async () => {},
        disconnect: async () => {},
        getConnectionStatus: () => ({ state: "connected" }),
      };
      instances.push(c);
      return c;
    }) as any,
  );
  t.after(() => transport.disconnect());
  return { transport, instances, received, logs };
}

test("unrecoverable connection is visible even when SDK status is stale; native arrival restores health", async (t) => {
  const x = connectionTransport(t);
  await x.transport.connect();
  const c = x.instances[0];
  assert.equal(c.options.safety.batch.text.delayMs, 0);
  assert.equal(c.options.keepalive.enabled, true);
  assert.equal(x.transport.status()[0].connection, "connected");
  assert.equal(x.transport.status()[0].lastRawAt, undefined);
  c.options.keepalive.onUnrecoverable(new Error("secret must not appear"));
  assert.equal(x.transport.status()[0].connection, "failed");
  assert.ok(x.transport.status()[0].lastErrorAt);
  assert.ok(!JSON.stringify(x.logs).includes("secret must not appear"));
  c.raw();
  assert.equal(x.transport.status()[0].connection, "connected");
  assert.ok(x.transport.status()[0].lastRawAt);
  assert.equal(x.transport.status()[0].lastMessageAt, undefined);
  c.handlers.message(message());
  assert.equal(x.received.length, 1);
  assert.ok(x.transport.status()[0].lastMessageAt);
});

test("replaced channel callbacks cannot deliver messages or poison new connection health", async (t) => {
  const x = connectionTransport(t);
  await x.transport.connect();
  const old = x.instances[0];
  await x.transport.disconnect();
  old.handlers.message(message());
  assert.equal(x.received.length, 0);
  await x.transport.connect();
  old.options.keepalive.onUnrecoverable(new Error("late"));
  old.raw();
  old.handlers.message(message());
  assert.equal(x.transport.status()[0].connection, "connected");
  assert.equal(x.transport.status()[0].lastRawAt, undefined);
  assert.equal(x.received.length, 0);
  const current = x.instances[1];
  for (const nativeId of ["m2", "m3"]) {
    current.handlers.message(message({ messageId: nativeId }));
  }
  assert.deepEqual(
    x.received.map((e) => e.nativeId),
    ["m2", "m3"],
  );
});

test("identity mismatch disconnects and prevents message dispatch", async (t) => {
  const x = connectionTransport(t);
  // The factory is invoked synchronously before connect() first yields.
  const pending = x.transport.connect();
  const c = x.instances[0];
  c.botIdentity.openId = "wrong-bot";
  await assert.rejects(pending, /bot_identity_mismatch/);
  c.handlers.message(message());
  assert.equal(x.received.length, 0);
  assert.deepEqual(x.transport.status(), []);
});

test("standalone send uses create with authorized chat and stable UUID, without quoting original", async () => {
  const x = reactionTransport();
  const requests: any[] = [];
  (x.channel.rawClient.im.message as any).create = async (args: any) => {
    requests.push(args);
    return { code: 0, data: { message_id: "standalone" } };
  };
  await x.transport.send(x.delivery);
  const receipt = await x.transport.send({
    ...x.delivery,
    id: "stable-id",
    mode: "message",
    status: "result",
    text: "1",
  });
  assert.equal(receipt.messageId, "standalone");
  assert.deepEqual(requests, [
    {
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "chat",
        content: JSON.stringify({ text: "1" }),
        msg_type: "text",
        uuid: "stable-id",
      },
    },
  ]);
  assert.deepEqual(x.texts, []);
  assert.equal(x.calls.at(-1), "remove");
  await assert.rejects(
    x.transport.send({
      ...x.delivery,
      mode: "message",
      status: "result",
      threadId: "topic",
    }),
    /invalid_standalone_message/,
  );
  (x.channel.rawClient.im.message as any).create = async () => ({ code: 999 });
  await assert.rejects(
    x.transport.send({ ...x.delivery, mode: "message", status: "result" }),
    /lark_send_unconfirmed/,
  );
});

test("confirmed cross-user delivery uses open_id, never the source chat as destination", async () => {
  const x = reactionTransport();
  let request: any;
  (x.channel.rawClient.im.message as any).create = async (args: any) => {
    request = args;
    return { code: 0, data: { message_id: "direct-receipt" } };
  };
  const d: Delivery = {
    ...x.delivery,
    mode: "direct",
    status: undefined,
    direct: { requestId: "proposal", openId: "ou_target", name: "宇翔" },
    text: "hi",
  };
  assert.equal((await x.transport.send(d)).messageId, "direct-receipt");
  assert.equal(request.params.receive_id_type, "open_id");
  assert.equal(request.data.receive_id, "ou_target");
  assert.equal(request.data.uuid, d.id);
  assert.equal(request.path, undefined);
  await assert.rejects(
    x.transport.send({ ...d, direct: undefined }),
    /invalid_direct_message/,
  );
});

test("provider rejection is definite for returned and thrown SDK responses, without exposing credentials", async () => {
  const x = reactionTransport();
  for (const shape of ["returned", "thrown"]) {
    (x.channel.rawClient.im.message as any).create = async () => {
      const body = {
        code: 230013,
        msg: "unsafe token=SECRET",
        error: { log_id: "SECRET" },
      };
      if (shape === "thrown")
        throw { response: { data: body }, config: { token: "SECRET" } };
      return body;
    };
    await assert.rejects(
      x.transport.send({
        ...x.delivery,
        mode: "direct",
        status: undefined,
        direct: { requestId: "p", openId: "ou_target", name: "宇翔" },
      }),
      (e: any) => {
        assert.equal(e.outcome, "failed");
        assert.equal(e.providerCode, 230013);
        assert.match(e.userMessage, /应用可用范围/);
        assert.doesNotMatch(JSON.stringify(e), /SECRET/);
        return true;
      },
    );
  }
});

test("timeouts, unknown provider codes and success without a receipt remain uncertain", async () => {
  const x = reactionTransport();
  for (const response of [null, { code: 230049 }, { code: 0, data: {} }]) {
    (x.channel.rawClient.im.message as any).create = async () => {
      if (!response) throw new Error("timeout with secret");
      return response;
    };
    await assert.rejects(
      x.transport.send({ ...x.delivery, mode: "message", status: "result" }),
      (e: any) => {
        assert.equal(e.outcome, "unknown");
        assert.equal(e.userMessage, undefined);
        return true;
      },
    );
  }
});

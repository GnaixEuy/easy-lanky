import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Host } from "../src/host.js";
import { configSchema } from "../src/config.js";
import { MessageRecovery, type HistoryPage } from "../src/recovery.js";
function setup(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-recovery-"));
  const config = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "agent", runtime: "codex", executable: "codex" }],
    projects: [{ id: "p", root: dir }],
    bots: [
      {
        id: "b",
        agentId: "agent",
        tenant: "feishu",
        tenantKey: "tenant",
        appType: "custom",
        appId: "app",
        appSecretEnv: "SECRET",
        selfOpenId: "bot",
        peers: {},
      },
    ],
    bindings: [
      {
        id: "scope",
        botId: "b",
        chatId: "chat",
        threadId: null,
        projectId: "p",
        allowedUsers: ["user"],
        allowedAgents: [],
        allowWrites: false,
        allowSend: true,
      },
    ],
  });
  const store = new Store(dir),
    host = new Host(config, store, new Map(), {
      send: async () => ({ messageId: "out" }),
    });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const since = Date.now() - 60000;
  const item = {
    message_id: "msg",
    chat_id: "chat",
    create_time: String(since + 1000),
    msg_type: "text",
    body: { content: JSON.stringify({ text: "你好" }) },
    sender: {
      id: "user",
      id_type: "open_id",
      sender_type: "user",
      tenant_key: "tenant",
    },
  };
  let page: HistoryPage = { items: [item] },
    ready = true;
  const recovery = new MessageRecovery(
    host,
    () => ready,
    async () => page,
    (e) => host.receive(e),
    () => {},
  );
  const seed = () =>
    store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run("message-recovery:scope", JSON.stringify({ since }));
  return {
    host,
    store,
    recovery,
    item,
    seed,
    setPage: (p: HistoryPage) => {
      page = p;
    },
    pause: () => {
      ready = false;
    },
  };
}
test("one chat history failure does not starve other chats or advance the failed cursor", async (t) => {
  const x = setup(t);
  x.seed();
  x.host.config.bindings.push({
    ...x.host.config.bindings[0],
    id: "second",
    chatId: "other-chat",
  });
  const before = (
    x.store.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("message-recovery:scope") as any
  ).value;
  x.store.db
    .prepare("INSERT INTO meta VALUES (?,?)")
    .run("message-recovery:second", before);
  const logs: object[] = [];
  const recovery = new MessageRecovery(
    x.host,
    () => true,
    async (binding) => {
      if (binding.id === "scope") throw new Error("private-provider-error");
      return { items: [{ ...x.item, chat_id: "other-chat" }] };
    },
    (e) => x.host.receive(e),
    (e) => logs.push(e),
  );
  await recovery.poll();
  assert.equal(x.store.runs().length, 1);
  assert.equal(x.store.runs()[0].bindingId, "second");
  assert.equal(
    (
      x.store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("message-recovery:scope") as any
    ).value,
    before,
  );
  assert.deepEqual(logs[0], {
    kind: "message_recovery_failed",
    botId: "b",
    bindingId: "scope",
  });
  assert.ok(!JSON.stringify(logs).includes("private-provider-error"));
});

test("first enablement skips old history; authorized missed message executes once across REST and socket", async (t) => {
  const x = setup(t);
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 0);
  x.seed();
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 1);
  x.seed();
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 1);
  assert.equal(
    x.host.receive({
      botId: "b",
      nativeId: "msg",
      tenantKey: "tenant",
      chatId: "chat",
      threadId: null,
      senderId: "user",
      senderType: "human",
      text: "你好",
      mentions: [],
      mentionAll: false,
      chatType: "p2p",
    }).status,
    "duplicate",
  );
});
test("history never grants authority to other users, tenants, bots, chats, edits or topics", async (t) => {
  const x = setup(t);
  x.seed();
  x.setPage({
    items: [
      { ...x.item, sender: { ...x.item.sender, tenant_key: "other" } },
      { ...x.item, sender: { ...x.item.sender, id: "other" } },
      { ...x.item, sender: { ...x.item.sender, sender_type: "app" } },
      { ...x.item, updated: true },
      { ...x.item, upper_message_id: "thread" },
      { ...x.item, chat_id: "elsewhere" },
      { ...x.item, mentions: [{}] },
    ],
  });
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 0);
});
test("pagination cursor survives cycles and queue pressure leaves page available for retry", async (t) => {
  const x = setup(t);
  x.seed();
  x.setPage({ items: [x.item], has_more: true, page_token: "next" });
  await x.recovery.poll();
  let cursor = JSON.parse(
    (
      x.store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("message-recovery:scope") as any
    ).value,
  );
  assert.equal(cursor.page, "next");
  assert.ok(cursor.until);
  x.setPage({ items: [{ ...x.item, message_id: "msg2" }], has_more: false });
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 2);
  x.seed();
  x.host.config.maxConcurrent = 1;
  x.host.config.maxQueue = 1;
  x.setPage({ items: [{ ...x.item, message_id: "msg3" }] });
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 2);
  cursor = JSON.parse(
    (
      x.store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("message-recovery:scope") as any
    ).value,
  );
  assert.equal(cursor.page, undefined);
  assert.equal(cursor.floor, undefined);
  x.host.config.maxQueue = 10;
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 3);
});
test("paused connection does not consume history", async (t) => {
  const x = setup(t);
  x.seed();
  x.pause();
  await x.recovery.poll();
  assert.equal(x.host.store.runs().length, 0);
});

test("authorized history preserves verified user mentions for recipient resolution", async (t) => {
  const x = setup(t);
  x.seed();
  x.setPage({
    items: [
      {
        ...x.item,
        body: { content: JSON.stringify({ text: "给 @_user_1 发hi" }) },
        mentions: [
          {
            key: "@_user_1",
            id: "ou_target",
            id_type: "open_id",
            name: "宇翔",
          },
        ],
      },
    ],
  });
  await x.recovery.poll();
  const run = x.store.runs()[0];
  assert.equal(run.prompt, "给 宇翔 发hi");
  assert.deepEqual(run.mentionedContacts, [
    { openId: "ou_target", name: "宇翔" },
  ]);
});

test("missed private image messages use the same image context as live messages", async (t) => {
  const x = setup(t);
  x.seed();
  x.setPage({
    items: [
      {
        ...x.item,
        msg_type: "image",
        body: { content: JSON.stringify({ image_key: "img_received" }) },
      },
    ],
  });
  await x.recovery.poll();
  assert.deepEqual(x.store.runs()[0].imageKeys, ["img_received"]);
});

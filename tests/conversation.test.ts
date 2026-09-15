import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import {
  ConversationStore,
  importPrivateHistory,
} from "../src/conversation.js";
import { configSchema } from "../src/config.js";
function setup(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-context-"));
  const cfg = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "a", runtime: "codex", executable: "codex" }],
    projects: [{ id: "p", root: dir }],
    bots: [
      {
        id: "b",
        agentId: "a",
        appId: "app",
        tenant: "feishu",
        tenantKey: "tenant",
        appType: "custom",
        appSecretEnv: "SECRET",
        selfOpenId: "self",
      },
    ],
    bindings: [
      {
        id: "binding",
        botId: "b",
        chatId: "chat",
        threadId: null,
        projectId: "p",
        allowedUsers: ["user"],
        allowSend: true,
      },
    ],
  });
  const store = new Store(dir);
  const h = new ConversationStore(store);
  const ref = h.current(cfg, cfg.bindings[0], cfg.bots[0], "user");
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cfg, store, h, ref };
}
test("chat scope includes application, topic, user and actual workspace; model switches preserve context", (t) => {
  const { h, ref, cfg } = setup(t);
  const b = cfg.bindings[0],
    bot = cfg.bots[0];
  for (const change of [{ chatId: "other" }, { threadId: "topic" }])
    assert.notEqual(
      h.current(cfg, { ...b, ...change }, bot, "user").scope,
      ref.scope,
    );
  assert.notEqual(
    h.current(cfg, b, { ...bot, appId: "other-app" }, "user").scope,
    ref.scope,
  );
  cfg.agents[0].model = "new-model";
  assert.deepEqual(h.current(cfg, b, bot, "user"), ref);
  cfg.projects[0].root += "/different";
  assert.notEqual(h.current(cfg, b, bot, "user").scope, ref.scope);
  assert.throws(
    () => h.current(cfg, b, bot, "intruder"),
    /conversation_scope_rejected/,
  );
});
test("transcript and reset survive restart; first known message survives bounded history", (t) => {
  const x = setup(t);
  x.h.user(x.ref, "first", "earliest-message", 1);
  x.h.reply(x.ref, "first", "first-reply");
  for (let i = 0; i < 70; i++)
    x.h.user(x.ref, "m" + i, "message-" + i + "x".repeat(1500), i + 2);
  const ctx = x.h.context(x.ref);
  assert.equal(ctx.earliestUserMessage, "earliest-message");
  assert.equal(ctx.totalPriorTurns, 71);
  assert.ok(ctx.truncated);
  assert.ok(ctx.omittedTurns > 0);
  assert.ok(ctx.turns.some((t) => t.id === "m69"));
  x.store.close();
  const restarted = new Store(x.dir);
  try {
    const h = new ConversationStore(restarted);
    assert.equal(h.context(x.ref).turns[0].reply, "first-reply");
    h.reset(x.ref);
    assert.notEqual(
      h.current(x.cfg, x.cfg.bindings[0], x.cfg.bots[0], "user").epoch,
      x.ref.epoch,
    );
  } finally {
    restarted.close();
  }
});
test("explicit history import filters foreign identities and never creates runs or deliveries", (t) => {
  const x = setup(t),
    b = x.cfg.bindings[0],
    bot = x.cfg.bots[0];
  const human = {
    message_id: "m",
    chat_id: "chat",
    create_time: "1000",
    msg_type: "text",
    sender: {
      id: "user",
      id_type: "open_id",
      sender_type: "user",
      tenant_key: "tenant",
    },
    body: { content: JSON.stringify({ text: "earliest" }) },
  };
  const reply = {
    ...human,
    message_id: "reply",
    create_time: "1100",
    parent_id: "m",
    sender: {
      id: "app",
      id_type: "app_id",
      sender_type: "app",
      tenant_key: "tenant",
    },
    body: { content: JSON.stringify({ text: "confirmed" }) },
  };
  const input = [
    human,
    reply,
    {
      ...human,
      message_id: "foreign",
      sender: { ...human.sender, id: "outsider" },
    },
    {
      ...reply,
      message_id: "foreignReply",
      sender: { ...reply.sender, id: "other-app" },
    },
    { ...human, message_id: "otherchat", chat_id: "different" },
    { ...human, message_id: "edited", updated: true },
  ];
  assert.equal(importPrivateHistory(x.h, x.ref, b, bot, "user", input), 1);
  assert.deepEqual(x.store.runs(), []);
  assert.deepEqual(x.store.deliveries(), []);
  assert.equal(x.h.context(x.ref).turns[0].reply, "confirmed");
  assert.equal(x.h.context(x.ref).totalPriorTurns, 1);
});

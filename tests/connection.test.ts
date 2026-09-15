import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema, loadConfig } from "../src/config.js";
import { Host } from "../src/host.js";
import { Store } from "../src/store.js";
import { ConfigurationManager } from "../src/configuration.js";
import { ConnectionService } from "../src/connection.js";
import type { Inbound } from "../src/contracts.js";
function setup(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-connection-"));
  const config = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "chatgpt", runtime: "codex", executable: "codex" }],
    bots: [
      {
        id: "bot",
        projectId: "project",
        agentId: "chatgpt",
        tenant: "feishu",
        tenantKey: "tenant",
        appType: "custom",
        appId: "app",
        appSecretEnv: "TEST_SECRET",
        selfOpenId: "self",
        peers: {},
      },
    ],
    projects: [{ id: "project", root: dir }],
    bindings: [],
  });
  const file = path.join(dir, "config.local.json");
  writeFileSync(file, JSON.stringify(config));
  const store = new Store(dir);
  let sends = 0,
    executes = 0,
    fail = false;
  const transport = {
    connect: async () => {
      if (fail) throw new Error("credential-detail-must-not-leak");
    },
    disconnect: async () => {},
    status: () => [{ botId: "bot", connection: "connected" }],
    send: async () => {
      sends++;
      return { messageId: `reply-${sends}` };
    },
  };
  const host = new Host(config, store, new Map(), transport);
  const manager = new ConfigurationManager(file, host);
  const connection = new ConnectionService(manager, transport);
  const event: Inbound = {
    botId: "bot",
    nativeId: "m1",
    tenantKey: "tenant",
    chatId: "chat",
    threadId: null,
    senderId: "user",
    senderType: "human",
    text: "hello",
    mentions: [],
    mentionAll: false,
    chatType: "p2p",
  };
  t.after(async () => {
    await host.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    file,
    host,
    store,
    manager,
    connection,
    event,
    transport,
    sends: () => sends,
    executes: () => executes,
    fail: () => {
      fail = true;
    },
    adapter: () =>
      host.adapters.set("chatgpt", {
        capabilities: {
          runtime: "test",
          localTools: true,
          resume: false,
          cancellation: "abort",
        },
        execute: async () => {
          executes++;
          return { decision: { text: "done", delegate: null } };
        },
      }),
  };
}
test("offline cannot receive; directed human needs explicit authorization; next message executes and replies", async (t) => {
  const x = setup(t);
  assert.equal(x.connection.receive(x.event).status, "connection_not_ready");
  await x.connection.connect();
  x.adapter();
  assert.equal(x.connection.receive(x.event).status, "unbound_target");
  assert.equal(x.sends(), 0);
  assert.equal(x.store.runs().length, 0);
  const candidate = x.connection.snapshot().candidates[0];
  const result = x.connection.authorize(
    candidate.id,
    x.manager.snapshot().revision,
  );
  assert.equal(result.pendingRestart, false);
  assert.equal(loadConfig(x.file).bindings[0].allowWrites, false);
  assert.deepEqual(x.config.bindings[0].allowedUsers, ["user"]);
  assert.equal(x.store.runs().length, 0); // Approval must not replay old text.
  assert.equal(
    x.connection.receive({ ...x.event, nativeId: "m2" }).status,
    "accepted",
  );
  await x.host.tick();
  while (x.host.active.size) await new Promise((r) => setTimeout(r, 5));
  await x.host.tick();
  assert.equal(x.executes(), 1);
  assert.equal(x.sends(), 2);
  assert.equal(
    x.connection.receive({ ...x.event, nativeId: "m3", senderId: "other" })
      .status,
    "user_not_authorized",
  );
  assert.equal(
    x.connection.receive({
      ...x.event,
      nativeId: "m4",
      threadId: "other-topic",
    }).status,
    "unbound_target",
  );
});
test("untrusted, agent, broadcast and undirected group messages cannot propose bindings", async (t) => {
  const x = setup(t);
  await x.connection.connect();
  for (const override of [
    { tenantKey: "other" },
    { senderType: "agent" as const },
    { senderType: "unknown" as const },
    { mentionAll: true },
    { chatType: "group" as const },
    { senderId: "self" },
  ])
    x.connection.receive({ ...x.event, ...override });
  assert.equal(x.connection.snapshot().candidates.length, 0);
  x.connection.receive({ ...x.event, chatType: "group", mentions: ["self"] });
  assert.equal(x.connection.snapshot().candidates.length, 1);
});
test("expired and stale approvals fail without changing authorization; candidates bounded and deduped", async (t) => {
  const x = setup(t);
  await x.connection.connect();
  x.connection.receive(x.event);
  x.connection.receive(x.event);
  assert.equal(x.connection.snapshot().candidates.length, 1);
  const c = x.connection.snapshot().candidates[0];
  assert.throws(
    () => x.connection.authorize(c.id, "stale"),
    /config_revision_conflict/,
  );
  assert.equal(x.config.bindings.length, 0);
  c.expiresAt = 0;
  assert.throws(
    () => x.connection.authorize(c.id, x.manager.snapshot().revision),
    /conversation_expired/,
  );
  for (let n = 0; n < 120; n++)
    x.connection.receive({ ...x.event, senderId: `user-${n}` });
  assert.equal(x.connection.snapshot().candidates.length, 100);
});
test("connection failures stay offline, redact errors and release lock for retry", async (t) => {
  const x = setup(t);
  x.fail();
  await assert.rejects(
    x.connection.connect(),
    /^Error: lark_connection_failed$/,
  );
  assert.equal(x.connection.offline, true);
  assert.equal(x.manager.busy, false);
  assert.equal(x.connection.receive(x.event).status, "connection_not_ready");
});
test("applying configuration refuses active work and concurrent writes during connection", async (t) => {
  const x = setup(t);
  let release!: () => void;
  x.transport.connect = () =>
    new Promise<void>((r) => {
      release = r;
    });
  const pending = x.connection.connect();
  await new Promise((r) => setImmediate(r));
  assert.throws(
    () => x.manager.save(x.config, x.manager.snapshot().revision),
    /connection_busy/,
  );
  await assert.rejects(x.connection.connect(), /connection_busy/);
  release();
  await pending;
  x.host.submitLocal({
    requestId: "request",
    agentId: "chatgpt",
    projectId: "project",
    prompt: "test",
    allowWrites: false,
  });
  await assert.rejects(x.connection.connect(), /config_change_requires_review/);
});
test("connection HTTP endpoints enforce authentication and origin before connecting or authorizing", async (t) => {
  const { createServer } = await import("node:http");
  const { createControlHandler } = await import("../src/control.js");
  const x = setup(t);
  let handler: ReturnType<typeof createControlHandler>;
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  handler = createControlHandler({
    host: x.host,
    token: "test-admin",
    offline: true,
    channels: () => x.transport.status(),
    connection: x.connection,
    configuration: x.manager,
    onStop() {},
    origin,
  });
  const post = (route: string, body: unknown, headers = {}) =>
    fetch(origin + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const route of [
    "/api/connection/connect",
    "/api/conversations/authorize",
    "/api/conversations/revoke",
  ]) {
    assert.equal((await post(route, {})).status, 401);
    assert.equal(
      (
        await post(
          route,
          {},
          {
            Authorization: "Bearer test-admin",
            Origin: "https://other.example",
          },
        )
      ).status,
      403,
    );
  }
  assert.equal(x.connection.offline, true);
  const connected = await post(
    "/api/connection/connect",
    {},
    { Authorization: "Bearer test-admin" },
  );
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).busy, false);
  x.connection.receive(x.event);
  const candidate = x.connection.snapshot().candidates[0];
  const approval = await post(
    "/api/conversations/authorize",
    { id: candidate.id, revision: x.manager.snapshot().revision },
    { Authorization: "Bearer test-admin" },
  );
  assert.equal(approval.status, 200);
  assert.equal((await approval.json()).pendingRestart, false);
  assert.equal(x.sends(), 0);
});
test("saved settings apply without process restart and retain the persisted fingerprint", async (t) => {
  const x = setup(t);
  const snapshot = x.manager.snapshot();
  snapshot.config.bots[0].name = "Updated bot";
  x.manager.save(snapshot.config, snapshot.revision);
  assert.equal(x.manager.pendingRestart, true);
  await x.connection.connect();
  assert.equal(x.config.bots[0].name, "Updated bot");
  assert.equal(x.manager.pendingRestart, false);
  x.connection.receive(x.event);
  x.connection.authorize(
    x.connection.snapshot().candidates[0].id,
    x.manager.snapshot().revision,
  );
  const { digest } = await import("../src/contracts.js");
  assert.equal(
    (
      x.store.db
        .prepare("SELECT value FROM meta WHERE key='config'")
        .get() as any
    ).value,
    digest(loadConfig(x.file)),
  );
});

test("revoking a person persists and takes effect immediately without granting anyone else access", async (t) => {
  const x = setup(t);
  await x.connection.connect();
  x.connection.receive(x.event);
  x.connection.authorize(
    x.connection.snapshot().candidates[0].id,
    x.manager.snapshot().revision,
  );
  x.connection.receive({
    ...x.event,
    nativeId: "other-request",
    senderId: "other",
  });
  x.connection.authorize(
    x.connection.snapshot().candidates[0].id,
    x.manager.snapshot().revision,
  );
  const bindingId = x.config.bindings[0].id;
  assert.throws(
    () => x.connection.revoke(bindingId, "user", "stale"),
    /config_revision_conflict/,
  );
  assert.ok(x.config.bindings[0].allowedUsers.includes("user"));
  const result = x.connection.revoke(
    bindingId,
    "user",
    x.manager.snapshot().revision,
  );
  assert.equal(result.pendingRestart, false);
  assert.deepEqual(loadConfig(x.file).bindings[0].allowedUsers, ["other"]);
  assert.equal(
    x.connection.receive({ ...x.event, nativeId: "revoked-request" }).status,
    "user_not_authorized",
  );
  assert.equal(x.store.runs().length, 0);
  assert.equal(x.sends(), 0);
  assert.ok(
    x.store.db.prepare("SELECT 1 FROM audit WHERE kind='access_revoked'").get(),
  );
  assert.throws(
    () => x.connection.revoke(bindingId, "user", x.manager.snapshot().revision),
    /user_not_authorized/,
  );
  const candidate = x.connection
    .snapshot()
    .candidates.find((c) => c.senderId === "user")!;
  x.connection.authorize(candidate.id, x.manager.snapshot().revision);
  assert.ok(x.config.bindings[0].allowedUsers.includes("user"));
  assert.equal(x.store.runs().length, 0);
});

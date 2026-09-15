import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { Host } from "../src/host.js";
import { createControlHandler } from "../src/control.js";
import type {
  Adapter,
  ExecuteInput,
  ExecuteResult,
} from "../src/adapters/cli.js";
const input = {
  requestId: "task-1",
  agentId: "chatgpt",
  projectId: "project",
  prompt: "inspect files",
  allowWrites: false,
};
async function setup(
  t: any,
  execute: (i: ExecuteInput) => Promise<ExecuteResult> = async () => ({
    decision: { text: "done", delegate: null },
  }),
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easy-larky-control-"));
  const config = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "chatgpt", runtime: "codex", executable: "codex" }],
    projects: [{ id: "project", root: dir }],
    bots: [],
    bindings: [],
  });
  const store = new Store(dir);
  let calls = 0,
    sends = 0;
  const adapter: Adapter = {
    capabilities: {
      runtime: "test",
      localTools: true,
      resume: false,
      cancellation: "abort",
    },
    execute: async (i) => {
      calls++;
      return execute(i);
    },
  };
  const host = new Host(config, store, new Map([["chatgpt", adapter]]), {
    send: async () => {
      sends++;
      return { messageId: "unexpected" };
    },
  });
  let handler: ReturnType<typeof createControlHandler>;
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = "test-admin-token";
  handler = createControlHandler({
    host,
    token,
    offline: true,
    channels: () => [],
    onStop: () => {},
    origin,
  });
  t.after(async () => {
    await host.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = (
    route: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + route, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  return {
    host,
    store,
    config,
    api,
    origin,
    calls: () => calls,
    sends: () => sends,
  };
}
async function finish(host: Host) {
  await host.tick();
  while (host.active.size) await new Promise((r) => setTimeout(r, 5));
}
test("control blocks unauthenticated and cross-origin requests without exposing configuration", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.api("/api/state", undefined, { Authorization: "" })).status,
    401,
  );
  assert.equal(
    (await f.api("/api/runs", input, { Origin: "https://untrusted.example" }))
      .status,
    403,
  );
  const forged = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      f.origin + "/api/state",
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forged, 403);
  assert.equal((await f.api("/api/runs", { ...input, cwd: "/" })).status, 400);
  assert.equal(
    (await f.api("/api/runs", { ...input, agentId: "unknown" })).status,
    400,
  );
  assert.equal(f.store.runs().length, 0);
  const state = await (await f.api("/api/state")).json();
  assert.equal(JSON.stringify(state).includes("test-admin-token"), false);
  assert.equal(state.health.mode, "offline");
  const page = await f.api("/", undefined, { Authorization: "" });
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
});
test("single-use browser ticket grants a session, cannot mint tickets or stop Host, and logout revokes it", async (t) => {
  const f = await setup(t);
  const link = await (await f.api("/api/session-ticket", {})).json();
  const ticket = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
    "ticket",
  );
  const auth = await (
    await f.api("/api/session", { ticket }, { Authorization: "" })
  ).json();
  assert.ok(auth.token);
  assert.equal(
    (await f.api("/api/session", { ticket }, { Authorization: "" })).status,
    401,
  );
  const headers = { Authorization: `Bearer ${auth.token}`, Origin: f.origin };
  assert.equal((await f.api("/api/state", undefined, headers)).status, 200);
  assert.equal((await f.api("/api/session-ticket", {}, headers)).status, 403);
  assert.equal((await f.api("/stop", {}, headers)).status, 403);
  assert.equal((await f.api("/api/logout", {}, headers)).status, 200);
  assert.equal((await f.api("/api/state", undefined, headers)).status, 401);
});
test("local HTTP task executes once, preserves writes scope and memory, and never sends IM", async (t) => {
  const f = await setup(t, async (i) => {
    assert.equal(i.allowWrites, false);
    assert.deepEqual(i.peers, []);
    assert.match(i.prompt, /LOCAL_PREFERENCE/);
    return {
      decision: { text: "done", delegate: null },
      sessionId: "fixture-session",
    };
  });
  f.host.memory.remember(
    { projectId: "project", userId: "local:operator", agentId: "chatgpt" },
    "preference",
    "LOCAL_PREFERENCE",
    "explicit-local-user",
  );
  const first = await (await f.api("/api/runs", input)).json();
  const second = await (await f.api("/api/runs", input)).json();
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.equal(first.runId, second.runId);
  assert.equal(
    (await f.api("/api/runs", { ...input, allowWrites: true })).status,
    409,
  );
  await finish(f.host);
  const detail = await (await f.api(`/api/runs/${first.runId}`)).json();
  assert.equal(detail.run.state, "completed");
  assert.equal(detail.source, "local");
  assert.equal(f.calls(), 1);
  assert.equal(f.sends(), 0);
  assert.equal(f.store.deliveries().length, 0);
  f.store.close();
  const reopened = new Store(f.config.stateDir);
  reopened.recover();
  assert.equal(reopened.get(first.runId)?.state, "completed");
  reopened.close();
});
test("local cancellation aborts active execution and late success cannot revive it", async (t) => {
  let aborted = false;
  const f = await setup(
    t,
    async (i) =>
      new Promise((resolve) =>
        i.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ decision: { text: "late result", delegate: null } });
        }),
      ),
  );
  f.host.submitLocal(input);
  await f.host.tick();
  assert.equal(f.store.get("local-task-1")?.state, "running");
  const cancelled = await (
    await f.api("/api/runs/local-task-1/cancel", {})
  ).json();
  assert.equal(cancelled.status, "cancelled");
  await finish(f.host);
  assert.equal(aborted, true);
  assert.equal(f.store.get("local-task-1")?.state, "cancelled");
  assert.equal(f.store.get("local-task-1")?.result, undefined);
  assert.equal(f.sends(), 0);
  assert.equal((await f.api("/api/runs/missing/cancel", {})).status, 400);
});
test("local delegation is refused even if the model invents a peer", async (t) => {
  const f = await setup(t, async () => ({
    decision: {
      text: "delegate",
      delegate: { agent: "grok", prompt: "do it" },
    },
  }));
  f.host.submitLocal(input);
  await finish(f.host);
  assert.equal(f.store.get("local-task-1")?.error, "delegation_not_authorized");
  assert.equal(f.store.deliveries().length, 0);
});
test("local queue survives reopening, cancelled queued run is not executed", async (t) => {
  const f = await setup(t);
  f.host.submitLocal(input);
  f.host.submitLocal({ ...input, requestId: "task-2" });
  f.host.cancelLocal("local-task-2");
  f.store.close();
  const reopened = new Store(f.config.stateDir);
  const restarted = new Host(
    f.config,
    reopened,
    f.host.adapters,
    f.host.transport,
  );
  try {
    reopened.recover();
    assert.equal(reopened.get("local-task-1")?.state, "queued");
    assert.equal(restarted.submitLocal(input).status, "duplicate");
    await finish(restarted);
    assert.equal(f.calls(), 1);
    assert.equal(reopened.get("local-task-2")?.state, "cancelled");
  } finally {
    await restarted.stop();
    reopened.close();
  }
});

test("oversized payload, full queue and Lark cancellation cannot cross local control boundaries", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.api("/api/runs", { ...input, prompt: "a".repeat(40000) })).status,
    400,
  );
  for (let n = 0; n < f.config.maxQueue + f.config.maxConcurrent; n++)
    f.host.submitLocal({ ...input, requestId: `q${n}` });
  assert.equal((await f.api("/api/runs", input)).status, 409);
  const run = f.store.get("local-q0")!;
  delete run.local;
  run.bindingId = "lark-binding";
  run.owner = "lark-user";
  f.store.save(run);
  assert.equal((await f.api("/api/runs/local-q0/cancel", {})).status, 400);
  assert.equal(f.store.get("local-q0")?.state, "queued");
});

test("local folder and model discovery require authenticated same-origin access", async (t) => {
  const f = await setup(t);
  for (const route of ["/api/directories", "/api/models"]) {
    assert.equal((await f.api(route, {}, { Authorization: "" })).status, 401);
    assert.equal(
      (await f.api(route, {}, { Origin: "https://untrusted.example" })).status,
      403,
    );
  }
  const listing = await f.api("/api/directories", {
    path: f.config.projects[0].root,
  });
  assert.equal(listing.status, 200);
  assert.deepEqual((await listing.json()).entries, []);
  assert.equal(
    (await f.api("/api/models", { agentId: "missing", executable: "injected" }))
      .status,
    400,
  );
  assert.equal(
    (await f.api("/api/models", { agentId: "missing" })).status,
    400,
  );
});

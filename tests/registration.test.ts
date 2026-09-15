import { gunzipSync } from "node:zlib";
import { requiredTenantScopes } from "../src/permissions-manifest.js";
import type { PermissionStatus } from "../src/permissions.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { Host } from "../src/host.js";
import { ConfigurationManager } from "../src/configuration.js";
import { RegistrationService } from "../src/registration.js";
function setup(t: any) {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "easy-larky-registration-")),
  );
  const file = path.join(dir, "host.local.json");
  const cfg = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "chatgpt", runtime: "codex", executable: "codex" }],
    projects: [{ id: "project", root: dir }],
    bots: [],
    bindings: [],
  });
  writeFileSync(file, JSON.stringify(cfg));
  const store = new Store(dir),
    host = new Host(cfg, store, new Map(), {
      send: async () => {
        throw new Error("unexpected_send");
      },
    });
  const manager = new ConfigurationManager(file, host);
  let now = 1000;
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const responses: any[] = [];
  const request = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body) });
    const next = responses.shift();
    return Response.json(typeof next === "function" ? await next() : next);
  }) as typeof fetch;
  const discover = async () => ({ openId: "ou_bot", tenantKey: "tenant" });
  let permissionState: PermissionStatus = {
    status: "granted",
    missing: [],
    undeclared: [],
    checkedAt: now,
  };
  let permissionCalls = 0;
  const permissions = {
    ensure: async () => {
      permissionCalls++;
      return { ...permissionState, checkedAt: now };
    },
  };
  const service = new RegistrationService(
    manager,
    request,
    () => now,
    discover,
    permissions,
  );
  const input = {
    id: "bot-qr",
    name: "扫码测试",
    agentId: "chatgpt",
    projectId: "project",
    tenant: "feishu",
    revision: manager.snapshot().revision,
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    file,
    manager,
    service,
    input,
    responses,
    calls,
    request,
    discover,
    permissions,
    setPermissions: (state: PermissionStatus) => {
      permissionState = state;
    },
    permissionCalls: () => permissionCalls,
    clock: () => now,
    advance: (ms = 6000) => {
      now += ms;
    },
  };
}
const begin = {
  device_code: "private-device",
  user_code: "USER1",
  expire_in: 600,
  interval: 5,
};
const success = {
  client_id: "cli_new",
  client_secret: "private-app-secret",
  user_info: { tenant_brand: "feishu" },
};
test("QR begin is idempotent, throttles polls, and never exposes device codes or credentials", async (t) => {
  const f = setup(t);
  f.responses.push(
    begin,
    { error: "authorization_pending" },
    { error: "slow_down" },
    success,
  );
  const first = await f.service.begin(f.input);
  assert.match(first.qr!, /^data:image\/png;base64,/);
  const link = new URL(first.url!);
  assert.equal(link.searchParams.get("user_code"), "USER1");
  assert.equal(link.searchParams.get("createOnly"), "true");
  const addons = JSON.parse(
    gunzipSync(
      Buffer.from(link.searchParams.get("addons")!, "base64url"),
    ).toString(),
  );
  assert.deepEqual(addons.scopes.tenant, requiredTenantScopes);
  assert.deepEqual(addons.events.items.tenant, ["im.message.receive_v1"]);
  assert.equal(addons.preset, true);
  assert.equal(JSON.stringify(first).includes("private-device"), false);
  assert.equal((await f.service.begin(f.input)).id, first.id);
  await f.service.poll(first.id);
  assert.equal(f.calls.length, 1);
  f.advance();
  await f.service.poll(first.id);
  f.advance();
  await f.service.poll(first.id);
  f.advance();
  await f.service.poll(first.id);
  assert.equal(f.calls.length, 3);
  f.advance();
  const ready = await f.service.poll(first.id);
  assert.equal(ready.status, "ready");
  assert.equal(JSON.stringify(ready).includes("private-app-secret"), false);
  assert.equal(
    statSync(f.file + ".registrations.local.json").mode & 0o777,
    0o600,
  );
  assert.equal(f.calls[0].body.get("archetype"), "PersonalAgent");
  assert.equal(
    f.calls[0].url,
    "https://accounts.feishu.cn/oauth/v1/app/registration",
  );
});
test("issued credentials survive restart and configuration conflict; retry saves PersonalAgent without any messages", async (t) => {
  const f = setup(t);
  f.responses.push(begin, success);
  const j = await f.service.begin(f.input);
  f.advance();
  await f.service.poll(j.id);
  f.manager.save(
    { ...f.manager.snapshot().config, maxQueue: 17 },
    f.input.revision,
  );
  const restored = new RegistrationService(
    f.manager,
    f.request,
    f.clock,
    f.discover,
    f.permissions,
  );
  await assert.rejects(restored.finish(j.id), /config_revision_conflict/);
  assert.equal((await restored.status(j.id)).status, "ready");
  const saved = await restored.finish(j.id, f.manager.snapshot().revision);
  assert.equal(saved.configuration.config.bots[0].appType, "personal-agent");
  assert.equal(saved.configuration.config.bots[0].selfOpenId, "ou_bot");
  assert.equal(saved.configuration.config.bindings.length, 0);
  assert.equal(JSON.stringify(saved).includes("private-app-secret"), false);
  assert.equal(
    readFileSync(f.file + ".registrations.local.json", "utf8").includes(
      "private-app-secret",
    ),
    false,
  );
  assert.equal((await restored.finish(j.id)).registration.status, "saved");
});
test("denied and expired registrations stop polling and cancel does not save a robot", async (t) => {
  const f = setup(t);
  f.responses.push(begin, { error: "access_denied" }, begin, begin);
  const a = await f.service.begin(f.input);
  f.advance();
  assert.equal((await f.service.poll(a.id)).status, "denied");
  const b = await f.service.begin(f.input);
  await f.service.cancel(b.id);
  f.advance();
  assert.equal((await f.service.poll(b.id)).status, "cancelled");
  const c = await f.service.begin(f.input);
  f.advance(600001);
  assert.equal((await f.service.poll(c.id)).status, "expired");
  assert.equal(f.calls.length, 4);
  assert.equal(f.manager.snapshot().config.bots.length, 0);
});
test("cross-brand discovery uses the official Lark endpoint and never accepts an arbitrary redirect", async (t) => {
  const f = setup(t);
  f.responses.push(
    begin,
    { error: "authorization_pending", user_info: { tenant_brand: "lark" } },
    { ...success, user_info: { tenant_brand: "lark" } },
  );
  const j = await f.service.begin({ ...f.input, tenant: "lark" });
  assert.match(j.url!, /^https:\/\/open.larksuite.com\//);
  f.advance();
  await f.service.poll(j.id);
  const result = await f.service.poll(j.id);
  assert.equal(result.status, "ready");
  assert.match(f.calls[2].url, /^https:\/\/accounts.larksuite.com\//);
  f.responses.push({
    ...begin,
    verification_uri_complete: "https://evil.example/steal",
  });
  await assert.rejects(
    f.service.begin({ ...f.input, id: "other" }),
    /registration_unavailable/,
  );
});
test("cancel racing with successful issuance preserves credentials for explicit recovery but never autosaves", async (t) => {
  const f = setup(t);
  let release: (data: any) => void = () => {};
  f.responses.push(
    begin,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const j = await f.service.begin(f.input);
  f.advance();
  const polling = f.service.poll(j.id);
  await f.service.cancel(j.id);
  release(success);
  const result = await polling;
  assert.equal(result.status, "ready");
  assert.equal(result.error, "registration_cancelled_after_creation");
  assert.equal(f.manager.snapshot().config.bots.length, 0);
  assert.equal(JSON.stringify(result).includes("private-app-secret"), false);
});

test("existing app automatically starts incremental authorization, preserves identity and never creates a second app", async (t) => {
  const f = setup(t);
  f.setPermissions({
    status: "configuration_required",
    missing: [requiredTenantScopes[0]],
    undeclared: [requiredTenantScopes[0]],
    checkedAt: 0,
  });
  f.responses.push(begin, { ...success, client_id: "cli_existing" });
  const input = {
    ...f.input,
    appId: "cli_existing",
    secret: "original-secret",
  };
  const connected = await f.service.connect(input);
  const job = connected.registration;
  assert.equal(job.flow, "permissions");
  assert.equal(job.status, "pending");
  const link = new URL(job.url!);
  assert.equal(link.searchParams.get("clientID"), "cli_existing");
  assert.equal(link.searchParams.has("createOnly"), false);
  const addons = JSON.parse(
    gunzipSync(
      Buffer.from(link.searchParams.get("addons")!, "base64url"),
    ).toString(),
  );
  assert.deepEqual(addons.scopes.tenant, requiredTenantScopes);
  assert.equal(JSON.stringify(job).includes("original-secret"), false);
  assert.equal((await f.service.connect(input)).registration.id, job.id);
  assert.equal(f.calls.length, 1);
  f.advance();
  await f.service.poll(job.id);
  f.setPermissions({
    status: "submitted",
    missing: [requiredTenantScopes[0]],
    undeclared: [],
    checkedAt: 0,
  });
  const waiting = await f.service.finish(job.id);
  assert.equal(waiting.configuration, undefined);
  assert.equal(f.manager.snapshot().config.bots.length, 0);
  f.advance(11000);
  f.setPermissions({
    status: "granted",
    missing: [],
    undeclared: [],
    checkedAt: 0,
  });
  const saved = await f.service.finish(job.id);
  assert.equal(saved.configuration!.config.bots[0].appId, "cli_existing");
  assert.equal(saved.configuration!.config.bots[0].appType, "custom");
});

test("wrong-app authorization is rejected and cannot replace the intended bot", async (t) => {
  const f = setup(t);
  f.setPermissions({
    status: "configuration_required",
    missing: [requiredTenantScopes[0]],
    undeclared: [requiredTenantScopes[0]],
    checkedAt: 0,
  });
  f.responses.push(begin, success);
  const result = await f.service.connect({
    ...f.input,
    appId: "cli_expected",
    secret: "secret",
  });
  f.advance();
  const wrong = await f.service.poll(result.registration.id);
  assert.equal(wrong.error, "registration_app_mismatch");
  assert.equal(f.manager.snapshot().config.bots.length, 0);
  assert.equal(wrong.appId, "cli_expected");
  assert.equal((await f.service.finish(wrong.id)).configuration, undefined);
});

test("cancelled permission confirmation retains credentials for an explicit restart", async (t) => {
  const f = setup(t);
  f.setPermissions({
    status: "configuration_required",
    missing: [requiredTenantScopes[0]],
    undeclared: [requiredTenantScopes[0]],
    checkedAt: 0,
  });
  f.responses.push(begin, begin);
  const result = await f.service.connect({
    ...f.input,
    appId: "cli_existing",
    secret: "secret",
  });
  const cancelled = await f.service.cancel(result.registration.id);
  assert.equal(cancelled.status, "ready");
  assert.equal(cancelled.error, "registration_authorization_cancelled");
  const restored = new RegistrationService(
    f.manager,
    f.request,
    f.clock,
    f.discover,
    f.permissions,
  );
  assert.equal((await restored.list())[0].appId, "cli_existing");
  const renewed = await restored.authorize(cancelled.id);
  assert.equal(renewed.status, "pending");
  assert.equal(
    new URL(renewed.url!).searchParams.get("clientID"),
    "cli_existing",
  );
});

test("a rejected credential can be corrected without creating another pending robot", async (t) => {
  const f = setup(t);
  const permissionCheck = {
    ensure: async (
      _brand: string,
      _app: string,
      secret: string,
    ): Promise<PermissionStatus> => {
      if (secret === "invalid") throw new Error("lark_credentials_rejected");
      return {
        status: "granted",
        missing: [],
        undeclared: [],
        checkedAt: f.clock(),
      };
    },
  };
  const service = new RegistrationService(
    f.manager,
    f.request,
    f.clock,
    f.discover,
    permissionCheck,
  );
  const input = { ...f.input, appId: "cli_existing", secret: "invalid" };
  await assert.rejects(service.connect(input), /lark_credentials_rejected/);
  const id = (await service.list())[0].id;
  const saved = await service.connect({ ...input, secret: "corrected" });
  assert.equal(saved.registration.id, id);
  assert.equal(saved.configuration!.config.bots.length, 1);
});

test("QR model choice survives pending registration restart and finish", async (t) => {
  const f = setup(t);
  f.responses.push(begin, success);
  const job = await f.service.begin({
    ...f.input,
    model: "robot-specific-model",
  });
  assert.equal(job.model, "robot-specific-model");
  f.advance();
  await f.service.poll(job.id);
  const restored = new RegistrationService(
    f.manager,
    f.request,
    f.clock,
    f.discover,
    f.permissions,
  );
  assert.equal((await restored.status(job.id)).model, "robot-specific-model");
  const saved = await restored.finish(job.id);
  assert.equal(
    saved.configuration.config.bots[0].model,
    "robot-specific-model",
  );
  assert.equal(saved.configuration.config.agents[0].model, undefined);
});

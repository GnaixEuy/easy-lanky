import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { Host } from "../src/host.js";
import { ConfigurationManager } from "../src/configuration.js";
function setup(t: any) {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "easy-larky-config-")),
  );
  const file = path.join(dir, "host.local.json");
  const config = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [{ id: "chatgpt", runtime: "codex", executable: "codex" }],
    projects: [{ id: "project", root: dir }],
    bots: [],
    bindings: [],
  });
  writeFileSync(file, JSON.stringify(config));
  const store = new Store(dir);
  const host = new Host(config, store, new Map(), {
    send: async () => {
      throw new Error("unexpected_send");
    },
  });
  const manager = new ConfigurationManager(file, host);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { file, config, store, host, manager };
}
test("configuration save creates exact backup, restrictive file, and marks restart only for semantic changes", (t) => {
  const f = setup(t);
  const before = readFileSync(f.file, "utf8");
  const current = f.manager.snapshot();
  const draft = structuredClone(current.config);
  draft.maxQueue = 17;
  const saved = f.manager.save(draft, current.revision);
  assert.equal(saved.pendingRestart, true);
  assert.equal(readFileSync(saved.backup, "utf8"), before);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(statSync(saved.backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.file, "utf8")).maxQueue, 17);
  const restored = f.manager.save(f.config, saved.revision);
  assert.equal(restored.pendingRestart, false);
});
test("configuration rejects stale revision and invalid references without changing file", (t) => {
  const f = setup(t);
  const s = f.manager.snapshot();
  writeFileSync(f.file, JSON.stringify({ ...f.config, maxQueue: 18 }));
  assert.throws(
    () => f.manager.save(f.config, s.revision),
    /config_revision_conflict/,
  );
  const before = readFileSync(f.file, "utf8");
  assert.throws(
    () =>
      f.manager.save(
        {
          ...f.config,
          projects: [
            { id: "project", root: "/nonexistent/easy-larky-acceptance" },
          ],
        },
        f.manager.snapshot().revision,
      ),
    /project_root_unavailable/,
  );
  assert.equal(readFileSync(f.file, "utf8"), before);
  assert.throws(
    () => f.manager.validate({ ...f.config, agents: [] }),
    /agent_project_required/,
  );
  assert.throws(
    () => f.manager.validate({ ...f.config, port: 9999 }),
    /runtime_location_readonly/,
  );
});
test("unfinished runs prevent config changes and preserve current file", (t) => {
  const f = setup(t);
  const before = readFileSync(f.file, "utf8");
  f.host.submitLocal({
    requestId: "queued",
    projectId: "project",
    agentId: "chatgpt",
    prompt: "test",
    allowWrites: false,
  });
  assert.throws(
    () =>
      f.manager.save(
        { ...f.config, maxQueue: 17 },
        f.manager.snapshot().revision,
      ),
    /config_change_requires_review/,
  );
  assert.equal(readFileSync(f.file, "utf8"), before);
  f.host.cancelLocal("local-queued");
  assert.equal(
    f.manager.save(f.config, f.manager.snapshot().revision).status,
    "saved",
  );
});
test("uncertain or blocked delivery prevents configuration replacement", (t) => {
  const f = setup(t);
  f.store.enqueue({
    id: "pending",
    botId: "test",
    chatId: "test",
    threadId: null,
    replyTo: "test",
    text: "fixture",
  });
  for (const state of ["pending", "unknown", "blocked"]) {
    f.store.deliveryState("pending", state);
    assert.throws(
      () => f.manager.save(f.config, f.manager.snapshot().revision),
      /config_change_requires_review/,
    );
  }
});

test("simple robot setup stores credentials separately and keeps secrets out of responses", async (t) => {
  const f = setup(t);
  const result = await f.manager.saveRobot(
    {
      id: "bot-one",
      name: "叶玥",
      agentId: "chatgpt",
      projectId: "project",
      tenant: "feishu",
      appId: "app_1",
      secret: "fixture-secret",
      revision: f.manager.snapshot().revision,
    },
    async () => ({ openId: "open_1", tenantKey: "tenant_1" }),
  );
  assert.equal(result.config.bots[0].name, "叶玥");
  assert.equal(result.config.bots[0].selfOpenId, "open_1");
  assert.deepEqual(result.config.bots[0].peers, {});
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  assert.equal(readFileSync(f.file, "utf8").includes("fixture-secret"), false);
  const secretsFile = `${f.file}.secrets.local.json`;
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(
    Object.values(JSON.parse(readFileSync(secretsFile, "utf8")))[0],
    "fixture-secret",
  );
  const metadata = await f.manager.saveRobot(
    {
      id: "bot-one",
      name: "叶玥二号",
      agentId: "chatgpt",
      projectId: "project",
      tenant: "feishu",
      appId: "app_1",
      revision: result.revision,
    },
    async () => {
      throw new Error("must_not_reconnect");
    },
  );
  assert.equal(metadata.config.bots[0].name, "叶玥二号");
});
test("failed identity lookup or stale configuration does not replace robot config or save supplied secret", async (t) => {
  const f = setup(t);
  const before = readFileSync(f.file, "utf8");
  const request = {
    id: "bot-one",
    name: "test",
    agentId: "chatgpt",
    projectId: "project",
    tenant: "feishu" as const,
    appId: "app_1",
    secret: "fixture-secret",
    revision: f.manager.snapshot().revision,
  };
  await assert.rejects(
    f.manager.saveRobot(request, async () => {
      throw new Error("lark_bot_unavailable");
    }),
    /lark_bot_unavailable/,
  );
  assert.equal(readFileSync(f.file, "utf8"), before);
  await assert.rejects(
    f.manager.saveRobot(request, async () => {
      writeFileSync(f.file, JSON.stringify({ ...f.config, maxQueue: 17 }));
      return { openId: "open_1", tenantKey: "tenant_1" };
    }),
    /config_revision_conflict/,
  );
});

test("rotating a secret keeps existing grants but replacing a bound bot is rejected", async (t) => {
  const f = setup(t);
  const request = {
    id: "bot-one",
    name: "test",
    agentId: "chatgpt",
    projectId: "project",
    tenant: "feishu" as const,
    appId: "app_1",
    secret: "first-secret",
    revision: f.manager.snapshot().revision,
  };
  const saved = await f.manager.saveRobot(request, async () => ({
    openId: "open_1",
    tenantKey: "tenant_1",
  }));
  const configured = f.manager.save(
    {
      ...saved.config,
      bindings: [
        {
          id: "binding",
          botId: "bot-one",
          chatId: "chat_1",
          threadId: null,
          projectId: "project",
          allowedUsers: ["user_1"],
          allowSend: true,
        },
      ],
    },
    saved.revision,
  );
  const rotated = await f.manager.saveRobot(
    { ...request, secret: "rotated-secret", revision: configured.revision },
    async () => ({ openId: "open_1", tenantKey: "tenant_1" }),
  );
  assert.deepEqual(rotated.config.bindings, configured.config.bindings);
  const configBefore = readFileSync(f.file, "utf8");
  const secretsBefore = readFileSync(`${f.file}.secrets.local.json`, "utf8");
  await assert.rejects(
    f.manager.saveRobot(
      {
        ...request,
        appId: "replacement",
        secret: "replacement-secret",
        revision: rotated.revision,
      },
      async () => ({ openId: "other", tenantKey: "tenant_1" }),
    ),
    /bot_replacement_requires_review/,
  );
  assert.equal(readFileSync(f.file, "utf8"), configBefore);
  assert.equal(
    readFileSync(`${f.file}.secrets.local.json`, "utf8"),
    secretsBefore,
  );
});

test("workspace names and model choice persist; deleting unused final workspace retains files", (t) => {
  const f = setup(t);
  const retained = path.join(f.config.projects[0].root, "user-document.txt");
  writeFileSync(retained, "keep me");
  const draft = structuredClone(f.config);
  draft.projects[0].name = "我的项目";
  draft.agents[0].model = "provider/custom-model";
  const changed = f.manager.save(draft, f.manager.snapshot().revision);
  assert.equal(changed.config.projects[0].name, "我的项目");
  assert.equal(changed.config.agents[0].model, "provider/custom-model");
  const removed = f.manager.save(
    { ...changed.config, projects: [] },
    changed.revision,
  );
  assert.deepEqual(removed.config.projects, []);
  assert.equal(readFileSync(retained, "utf8"), "keep me");
  const agents = removed.config.agents.map(({ model, ...a }) => a);
  const defaults = f.manager.save(
    { ...removed.config, agents },
    removed.revision,
  );
  assert.equal(defaults.config.agents[0].model, undefined);
});

test("workspace referenced by bot or binding cannot be deleted, and invalid model cannot replace config", async (t) => {
  const f = setup(t);
  const saved = await f.manager.saveRobot(
    {
      id: "bot",
      name: "robot",
      agentId: "chatgpt",
      projectId: "project",
      tenant: "feishu",
      appId: "app",
      secret: "fixture",
      revision: f.manager.snapshot().revision,
    },
    async () => ({ openId: "self", tenantKey: "tenant" }),
  );
  const before = readFileSync(f.file, "utf8");
  assert.throws(
    () => f.manager.save({ ...saved.config, projects: [] }, saved.revision),
    /invalid_binding/,
  );
  assert.equal(readFileSync(f.file, "utf8"), before);
  const bindingOnly = {
    ...saved.config,
    bots: saved.config.bots.map(({ projectId, ...b }) => b),
    bindings: [
      {
        id: "bind",
        botId: "bot",
        chatId: "chat",
        threadId: null,
        projectId: "project",
        allowedUsers: ["user"],
      },
    ],
  };
  const bound = f.manager.save(bindingOnly, saved.revision);
  assert.throws(
    () => f.manager.save({ ...bound.config, projects: [] }, bound.revision),
    /invalid_binding/,
  );
  assert.throws(() =>
    f.manager.save(
      {
        ...bound.config,
        agents: bound.config.agents.map((a) => ({
          ...a,
          model: "--unsafe argument",
        })),
      },
      bound.revision,
    ),
  );
  assert.equal(f.manager.snapshot().config.agents[0].model, undefined);
});

test("robot model overrides save independently, preserve older edits and clear explicitly", async (t) => {
  const f = setup(t);
  const create = async (id: string, model: string) =>
    f.manager.saveRobot(
      {
        id,
        name: id,
        agentId: "chatgpt",
        projectId: "project",
        tenant: "feishu",
        appId: `app_${id}`,
        secret: "fixture",
        model,
        revision: f.manager.snapshot().revision,
      },
      async () => ({ openId: `open_${id}`, tenantKey: "tenant" }),
    );
  await create("first", "model-a");
  await create("second", "model-b");
  const edit = {
    id: "first",
    name: "renamed",
    agentId: "chatgpt",
    projectId: "project",
    tenant: "feishu" as const,
    appId: "app_first",
  };
  await f.manager.saveRobot({
    ...edit,
    revision: f.manager.snapshot().revision,
  });
  assert.equal(
    f.manager.snapshot().config.bots.find((b) => b.id === "first")!.model,
    "model-a",
  );
  await f.manager.saveRobot({
    ...edit,
    model: "model-c",
    revision: f.manager.snapshot().revision,
  });
  let cfg = f.manager.snapshot().config;
  assert.equal(cfg.bots.find((b) => b.id === "first")!.model, "model-c");
  assert.equal(cfg.bots.find((b) => b.id === "second")!.model, "model-b");
  assert.equal(cfg.agents[0].model, undefined);
  await f.manager.saveRobot({
    ...edit,
    model: null,
    revision: f.manager.snapshot().revision,
  });
  cfg = f.manager.snapshot().config;
  assert.equal(cfg.bots.find((b) => b.id === "first")!.model, undefined);
  assert.equal(cfg.bots.find((b) => b.id === "second")!.model, "model-b");
  assert.equal(
    JSON.parse(readFileSync(f.file, "utf8")).bots.find(
      (b: any) => b.id === "second",
    ).model,
    "model-b",
  );
});

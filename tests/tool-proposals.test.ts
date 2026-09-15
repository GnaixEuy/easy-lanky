import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { ToolProposals } from "../src/tool-proposals.js";
import type { Run } from "../src/contracts.js";
import { configSchema } from "../src/config.js";
test("tool confirmation survives restart; in-flight/failed writes cannot be replayed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-proposals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = configSchema.parse({
    version: 1,
    stateDir: dir,
    agents: [],
    projects: [],
    bots: [
      {
        id: "bot",
        agentId: "agent",
        appType: "custom",
        appId: "cli_app",
        appSecretEnv: "UNUSED",
        tenant: "feishu",
        tenantKey: "tenant",
        selfOpenId: "ou_bot",
      },
    ],
    bindings: [
      {
        id: "binding",
        botId: "bot",
        chatId: "chat",
        threadId: null,
        projectId: "project",
        allowedUsers: ["owner"],
      },
    ],
  });
  const run = {
    id: "run",
    owner: "owner",
    conversation: { scope: "scope", epoch: 0 },
  } as Run;
  let store = new Store(dir);
  let p = new ToolProposals(store);
  const text = p.propose(
    run,
    config.bindings[0],
    config.bots[0],
    { argv: ["docs", "+create", "--title", "保留标题"] },
    { ok: true, output: '{"dry_run":true}' },
  );
  const id = text.match(/\/approve-tool ([a-f0-9]+)/)![1];
  store.close();
  store = new Store(dir);
  p = new ToolProposals(store);
  const request = p.claim(id, run, config.bindings[0], config.bots[0]);
  assert.equal(request.argv.at(-1), "保留标题");
  store.close();
  store = new Store(dir);
  p = new ToolProposals(store);
  assert.throws(
    () => p.claim(id, run, config.bindings[0], config.bots[0]),
    /already_processed/,
  );
  p.finish(id, { ok: false, output: "tool_timeout" });
  assert.throws(
    () => p.claim(id, run, config.bindings[0], config.bots[0]),
    /already_processed/,
  );
  store.close();
});

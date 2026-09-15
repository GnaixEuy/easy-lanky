// Explicit real-model smoke; intentionally excluded from npm test.
// No Lark transport is instantiated. Every IM event/receipt here is a local fixture.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { configSchema } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { Host } from "../dist/host.js";
import { CliAdapter } from "../dist/adapters/cli.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "../..");
const directory = path.join(
  workspace,
  "output",
  "acceptance",
  `host-${randomUUID()}`,
);
const project = path.join(directory, "workspace");
mkdirSync(project, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(project, "AGENTS.md"),
  "本目录仅用于 Host 验收。只完成指定文件任务；不读历史会话、不发消息、不启动其他 Agent、不提交发布、不修改目录外文件。\n",
);
const agent = { id: "chatgpt", runtime: "codex", executable: "codex" };
const config = configSchema.parse({
  version: 1,
  stateDir: path.join(directory, "state"),
  runTimeoutMs: 180000,
  agents: [agent],
  projects: [{ id: "acceptance", root: project }],
  bots: [
    {
      id: "mock-bot",
      agentId: "chatgpt",
      tenant: "feishu",
      tenantKey: "mock-tenant",
      appType: "custom",
      appId: "mock-app",
      appSecretEnv: "UNUSED_MOCK_SECRET",
      selfOpenId: "mock-self",
    },
  ],
  bindings: [
    {
      id: "mock-binding",
      botId: "mock-bot",
      chatId: "mock-chat",
      threadId: null,
      projectId: "acceptance",
      allowedUsers: ["mock-user"],
      allowSend: true,
      allowWrites: true,
    },
  ],
});
const store = new Store(config.stateDir);
const receipts = [];
let host = new Host(
  config,
  store,
  new Map([
    ["chatgpt", new CliAdapter(agent, config.stateDir, config.runTimeoutMs)],
  ]),
  {
    async send(delivery) {
      const receipt = `mock-receipt-${receipts.length + 1}`;
      receipts.push({ delivery, receipt });
      return { messageId: receipt };
    },
  },
);
process.once("SIGINT", () => void host.stop());
let runId;
try {
  const event = {
    botId: "mock-bot",
    nativeId: "mock-input",
    tenantKey: "mock-tenant",
    chatId: "mock-chat",
    threadId: null,
    senderId: "mock-user",
    senderType: "human",
    mentions: ["mock-self"],
    mentionAll: false,
    text: "仅完成 Host 验收：在当前目录创建 host-proof.txt，字节内容严格为 EASY_LARKY_HOST_OK 加一个换行；读取文件核对后汇报，不委派、不修改其他文件。",
  };
  const accepted = host.receive(event);
  assert.equal(accepted.status, "accepted");
  runId = accepted.runId;
  assert.equal(host.receive(event).status, "duplicate");
  const deadline = Date.now() + config.runTimeoutMs + 10000;
  while (Date.now() < deadline) {
    await host.tick();
    const run = store.get(runId);
    if (
      ["completed", "failed", "interrupted", "cancelled"].includes(run.state) &&
      host.active.size === 0
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await host.flush();
  const run = store.get(runId);
  assert.equal(run.state, "completed", run.error);
  assert.equal(
    readFileSync(path.join(project, "host-proof.txt"), "utf8"),
    "EASY_LARKY_HOST_OK\n",
  );
  assert.equal(receipts.length, 2);
  assert.ok(
    store
      .deliveries()
      .every(
        (d) => d.state === "sent" && d.receipt.startsWith("mock-receipt-"),
      ),
  );
  await host.stop();
  store.close();
  const reopened = new Store(config.stateDir);
  reopened.recover();
  assert.equal(reopened.get(runId).state, "completed");
  assert.equal(reopened.runs().length, 1);
  reopened.close();
  const evidence = {
    scope: "REAL_CODEX_HOST_WITH_MOCK_IM",
    runId,
    providerSession: run.providerSession,
    artifact: path.join(project, "host-proof.txt"),
    exactBytesVerified: true,
    duplicateDidNotCreateRun: true,
    restartPreservedCompletion: true,
    transport: "mock; no Lark connection or messages",
    receipts: receipts.map((r) => r.receipt),
  };
  writeFileSync(
    path.join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await host.stop();
  store.close();
}

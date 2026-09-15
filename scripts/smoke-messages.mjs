// Real configured CLI, isolated Host and simulated IM only; never sends to Lark.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configSchema, loadConfig } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { Host } from "../dist/host.js";
import { CliAdapter } from "../dist/adapters/cli.js";
const directMode = process.argv.includes("--direct");
const current = loadConfig("easy-larky.local.json");
const agent =
  current.agents.find((a) => a.id === current.bots[0]?.agentId) ??
  current.agents[0];
const directory = path.resolve(
  "../../output/acceptance",
  `messages-${randomUUID()}`,
);
const project = path.join(directory, "workspace");
mkdirSync(project, { recursive: true });
writeFileSync(
  path.join(project, "AGENTS.md"),
  "仅完成当前测试；不调用外部接口，不修改文件。消息由 Host 按结构化输出处理。\n",
);
const config = configSchema.parse({
  version: 1,
  stateDir: path.join(directory, "state"),
  runTimeoutMs: 180000,
  agents: [agent],
  projects: [{ id: "p", root: project }],
  bots: [
    {
      id: "bot",
      agentId: agent.id,
      tenant: "feishu",
      tenantKey: "fixture",
      appType: "custom",
      appId: "fixture",
      appSecretEnv: "UNUSED",
      selfOpenId: "self",
    },
  ],
  bindings: [
    {
      id: "b",
      botId: "bot",
      chatId: "fixture-chat",
      threadId: null,
      projectId: "p",
      allowedUsers: ["user"],
      allowSend: true,
    },
  ],
});
const store = new Store(config.stateDir);
const sent = [];
const host = new Host(
  config,
  store,
  new Map([
    [agent.id, new CliAdapter(agent, config.stateDir, config.runTimeoutMs)],
  ]),
  {
    async findContacts(_bot, query) {
      assert.ok(query.includes("宇翔"));
      return {
        contacts: [{ openId: "ou_target", name: "宇翔" }],
        incomplete: false,
      };
    },
    async send(d) {
      sent.push(d);
      return { messageId: `fixture-${sent.length}` };
    },
  },
);
try {
  const ref = host.conversations.current(
    config,
    config.bindings[0],
    config.bots[0],
    "user",
  );
  host.conversations.user(
    ref,
    "earlier",
    "你能主动发消息吗",
    Date.now() - 1000,
  );
  host.conversations.reply(
    ref,
    "earlier",
    "我目前只能回复你的消息，不能主动另发消息。",
  );
  const accepted = host.receive({
    botId: "bot",
    nativeId: "new-request",
    tenantKey: "fixture",
    chatId: "fixture-chat",
    threadId: null,
    senderId: "user",
    senderType: "human",
    chatType: "p2p",
    mentions: [],
    mentionAll: false,
    text: directMode
      ? "你现在给宇翔发一个 hi"
      : "你能主动发消息吗？现在请主动另发三条独立消息，分别为 1、2、3，不要合成一条，也不用额外说明。",
  });
  assert.equal(accepted.status, "accepted");
  const deadline = Date.now() + config.runTimeoutMs + 10000;
  while (Date.now() < deadline) {
    await host.tick();
    if (host.active.size === 0 && store.get(accepted.runId).state !== "queued")
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await host.flush();
  const run = store.get(accepted.runId);
  assert.equal(run.state, "completed", run.error);
  if (directMode) {
    assert.equal(sent.filter((d) => d.mode === "direct").length, 0);
    const code = run.result.match(/\/send ([a-f0-9]{12})/)[1];
    host.receive({
      botId: "bot",
      nativeId: "confirm",
      tenantKey: "fixture",
      chatId: "fixture-chat",
      threadId: null,
      senderId: "user",
      senderType: "human",
      chatType: "p2p",
      mentions: [],
      mentionAll: false,
      text: `/send ${code} 1`,
    });
    await host.flush();
    await host.flush();
    const delivered = sent.filter((d) => d.mode === "direct");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].direct.openId, "ou_target");
    assert.equal(delivered[0].text, "hi");
    assert.ok(sent.some((d) => d.text === "发送成功"));
  } else {
    assert.deepEqual(
      sent.filter((d) => d.status === "result").map((d) => [d.mode, d.text]),
      [
        ["message", "1"],
        ["message", "2"],
        ["message", "3"],
      ],
    );
    assert.equal(host.conversations.context(ref).turns.at(-1).reply, "1\n2\n3");
  }
  const evidence = {
    scenario: directMode
      ? "cross-user-preview-confirm-send-receipt"
      : "standalone-messages",
    scope: "REAL_CLI_HOST_MOCK_IM",
    runtime: agent.runtime,
    model: agent.model ?? "CLI_DEFAULT",
    runId: run.id,
    messages: directMode ? ["hi"] : ["1", "2", "3"],
    historicalRefusalCorrected: true,
    deliveredHistoryVerified: true,
    realLarkSend: false,
  };
  writeFileSync(
    path.join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ...evidence, directory }));
} finally {
  await host.stop();
  store.close();
}

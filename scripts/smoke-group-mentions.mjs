// Real configured model + real read-only Lark APIs; all inbound/outbound IM is simulated.
// No event connection, message sending, document creation, or permissions changes.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, configSchema } from "../dist/config.js";
import { loadSecrets } from "../dist/bot-setup.js";
import { Host } from "../dist/host.js";
import { Store } from "../dist/store.js";
import { CliAdapter } from "../dist/adapters/cli.js";
import { LarkTransport } from "../dist/channel/lark.js";
const local = loadConfig("easy-larky.local.json");
loadSecrets("easy-larky.local.json");
const bot = local.bots[0];
const agent = local.agents.find((a) => a.id === bot.agentId);
const binding = local.bindings.find(
  (b) => b.botId === bot.id && b.id === process.env.BINDING_ID,
);
assert.ok(binding, "Requires an existing authorized binding");
const output = path.resolve(
  "../../output/acceptance",
  `group-mentions-${randomUUID()}`,
);
const project = path.join(output, "project");
mkdirSync(project, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(project, "AGENTS.md"),
  "本目录为只读验收。使用提供的飞书工具查询。不要读取目录外文件，不进行任何外部写操作。\n",
);
const config = configSchema.parse({
  ...local,
  stateDir: path.join(output, "state"),
  agents: [agent],
  bots: [bot],
  projects: [{ id: binding.projectId, root: project }],
  bindings: [{ ...binding, allowWrites: false, allowedAgents: [] }],
  runTimeoutMs: 180000,
});
const store = new Store(config.stateDir);
const liveReadTransport = new LarkTransport(
  config,
  () => {},
  () => {},
);
// Read-only tools use REST; satisfy its configured-channel guard without opening a
// competing source connection. This fixture is NOT evidence of real inbound IM.
liveReadTransport.channels.set(bot.id, {});
const toolTrace = [];
const sent = [];
const host = new Host(
  config,
  store,
  new Map([
    [agent.id, new CliAdapter(agent, config.stateDir, config.runTimeoutMs)],
  ]),
  {
    async send(message) {
      sent.push(message);
      return { messageId: `simulated-${randomUUID()}` };
    },
    async runTool(botId, request, context) {
      assert.ok(
        (request.argv[0] === "im" &&
          request.argv[1] === "+chat-members-list") ||
          request.argv.at(-1) === "--help" ||
          ["skills", "schema"].includes(request.argv[0]),
        "Acceptance is group-member reads only",
      );
      assert.ok(!context.approved);
      const result = await liveReadTransport.runTool(botId, request, context);
      toolTrace.push({ request, result });
      return result;
    },
  },
);
try {
  const input = {
    botId: bot.id,
    nativeId: `simulated-input-${randomUUID()}`,
    tenantKey: bot.tenantKey,
    chatId: binding.chatId,
    threadId: binding.threadId,
    senderId: binding.allowedUsers[0],
    senderType: "human",
    mentions: [bot.selfOpenId],
    mentionAll: false,
    chatType: "group",
    text: "请查一下当前群里有没有叫007的机器人，有的话请真正艾特他，问他能提供哪些信息。",
  };
  const accepted = host.receive(input);
  assert.equal(accepted.status, "accepted");
  const deadline = Date.now() + config.runTimeoutMs * 4 + 5000;
  while (Date.now() < deadline) {
    await host.tick();
    const run = store.get(accepted.runId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.state))
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const run = store.get(accepted.runId);
  assert.equal(run.state, "completed", run.error);
  assert.ok(
    toolTrace.length >= 2,
    "Model lookup plus Host membership validation",
  );
  const members = toolTrace.flatMap(
    (x) => JSON.parse(x.result.output).data?.bots ?? [],
  );
  const target = members.find((x) => x.name === "007");
  assert.ok(target);
  const message = sent.find(
    (x) => x.mode === "message" && x.mentionIds?.includes(target.member_id),
  );
  assert.ok(message, "Model must emit native mention to queried 007");
  const report = {
    state: run.state,
    toolCalls: toolTrace.length,
    realModel: true,
    realMemberReads: true,
    realOutboundIM: false,
    result: run.result,
    nativeMention: true,
  };
  writeFileSync(
    path.join(output, "proof.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ output, ...report }));
} finally {
  await host.stop();
  store.close();
}

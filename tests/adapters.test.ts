import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CliAdapter, parseOutput } from "../src/adapters/cli.js";
const decision = JSON.stringify({ text: "ok", delegate: null });
test("Codex parser requires completed turn, valid structured result and no errors", () => {
  const stdout = [
    { type: "thread.started", thread_id: "session" },
    { type: "item.completed", item: { type: "agent_message", text: decision } },
    { type: "turn.completed" },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
  assert.equal(parseOutput("codex", stdout).decision.text, "ok");
  assert.throws(() =>
    parseOutput("codex", stdout.split("\n").slice(0, 2).join("\n")),
  );
  assert.throws(() =>
    parseOutput(
      "codex",
      stdout + "\n" + JSON.stringify({ type: "turn.failed" }),
    ),
  );
});
test("Grok parser contract fixture (not real Grok success evidence)", () => {
  assert.equal(
    parseOutput(
      "grok",
      JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: { text: "ok", delegate: null },
      }),
    ).decision.text,
    "ok",
  );
  assert.throws(() =>
    parseOutput(
      "grok",
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "failed",
      }),
    ),
  );
});
function stub(t: any, body: string, timeout = 1000) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easy-larky-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-cli");
  writeFileSync(file, "#!/usr/bin/env node\n" + body);
  chmodSync(file, 0o700);
  return {
    adapter: new CliAdapter(
      { id: "test", runtime: "codex", executable: file },
      dir,
      timeout,
    ),
    input: {
      id: "run",
      cwd: dir,
      prompt: "test",
      allowWrites: false,
      peers: [],
      signal: new AbortController().signal,
    },
  };
}
test("process timeout and nonzero exit do not become successes", async (t) => {
  const s = stub(t, "setInterval(()=>{},1000);", 30);
  await assert.rejects(s.adapter.execute(s.input), /runtime_timeout/);
  const f = stub(t, "process.exit(4);");
  await assert.rejects(f.adapter.execute(f.input), /runtime_exit_failed/);
});
test("actual process cancellation is isolated to that execution", async (t) => {
  const s = stub(t, "setInterval(()=>{},1000);");
  const c = new AbortController();
  setTimeout(() => c.abort(), 40);
  await assert.rejects(
    s.adapter.execute({ ...s.input, signal: c.signal }),
    /cancelled/,
  );
});
test("quota error is classified even when wrapped in CLI output", async (t) => {
  const s = stub(
    t,
    'console.log(JSON.stringify({type:"error",message:"Grok Build usage balance exhausted"}));process.exit(1);',
  );
  await assert.rejects(s.adapter.execute(s.input), /provider_quota_exhausted/);
});
test("spawn errors fail promptly and shell metacharacters stay in stdin", async (t) => {
  const s = stub(
    t,
    `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:input.includes('$(touch unsafe)')?'literal':'bad',delegate:null})}}));console.log(JSON.stringify({type:'turn.completed'}));});`,
  );
  const result = await s.adapter.execute({
    ...s.input,
    prompt: "$(touch unsafe)",
  });
  assert.equal(result.decision.text, "literal");
  s.adapter.agent.executable = "/no/such/easy-larky-cli";
  await assert.rejects(s.adapter.execute(s.input), /runtime_spawn_failed/);
});

test("selected model reaches Codex as one argument and clearing it restores CLI default", async (t) => {
  const s = stub(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>{const args=process.argv.slice(2);const at=args.indexOf('--model');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:at<0?'CLI_DEFAULT':args[at+1],delegate:null})}}));console.log(JSON.stringify({type:'turn.completed'}));});`,
  );
  s.adapter.agent.model = "provider/custom-model";
  assert.equal(
    (await s.adapter.execute(s.input)).decision.text,
    "provider/custom-model",
  );
  delete s.adapter.agent.model;
  assert.equal(
    (await s.adapter.execute({ ...s.input, id: "default-run" })).decision.text,
    "CLI_DEFAULT",
  );
});

test("per-execution robot model overrides Agent default without mutating shared adapter", async (t) => {
  const s = stub(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>{const args=process.argv.slice(2);const at=args.indexOf('--model');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:at<0?'CLI_DEFAULT':args[at+1],delegate:null})}}));console.log(JSON.stringify({type:'turn.completed'}));});`,
  );
  s.adapter.agent.model = "agent-default";
  for (const model of ["robot-a", "robot-b", undefined]) {
    assert.equal(
      (await s.adapter.execute({ ...s.input, model })).decision.text,
      model ?? "agent-default",
    );
    assert.equal(s.adapter.agent.model, "agent-default");
  }
});

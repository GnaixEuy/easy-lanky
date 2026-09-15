import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAdapter, parseOutput } from "../src/adapters/cli.js";
import { workspacePath, piToolsExtension } from "../src/adapters/pi-tools.js";
import { configSchema } from "../src/config.js";

const message = {
  role: "assistant",
  stopReason: "stop",
  content: [
    { type: "text", text: JSON.stringify({ text: "ok", delegate: null }) },
  ],
};
const event = (messages: unknown[]) =>
  JSON.stringify({ type: "agent_end", messages });
test("Pi accepts only final stopped assistant decisions, never partial/error/tool turns", () => {
  assert.equal(parseOutput("pi", event([message])).decision.text, "ok");
  for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
    assert.throws(() => parseOutput("pi", event([{ ...message, stopReason }])));
  }
  assert.throws(() =>
    parseOutput("pi", JSON.stringify({ type: "message_end", message })),
  );
  assert.throws(() =>
    parseOutput("pi", event([message, { role: "toolResult" }])),
  );
  assert.throws(() =>
    parseOutput(
      "pi",
      event([{ ...message, content: [{ type: "text", text: "plain text" }] }]),
    ),
  );
  assert.throws(() => parseOutput("pi", event([])));
});
test("Pi paths reject traversal and symlinks, including dangling write links", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(workspacePath(root, "new/file.txt").endsWith("new/file.txt"));
  for (const input of ["../outside", "/etc/passwd", undefined])
    assert.throws(() => workspacePath(root, input));
  symlinkSync("/no/such/path", path.join(root, "dangling"));
  symlinkSync(os.tmpdir(), path.join(root, "outside"));
  for (const input of ["dangling", "dangling/new", "outside/file"])
    assert.throws(() => workspacePath(root, input));
  assert.ok(
    !piToolsExtension(root, false).includes(
      "[createReadTool, createLsTool, createEditTool",
    ),
  );
});
test("Pi config accepts runtime and optional provider/model pattern", () => {
  const result = configSchema.parse({
    version: 1,
    stateDir: ".",
    agents: [
      {
        id: "pi",
        runtime: "pi",
        executable: "pi",
        model: "openai-codex/gpt-5.4",
      },
    ],
    bots: [],
    projects: [],
    bindings: [],
  });
  assert.equal(result.agents[0].runtime, "pi");
});
test("Pi subprocess uses isolated file tools, literal stdin and shared cancellation/timeout", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "pi-stub");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
const expected=process.env.EASY_LARKY_TEST_SECRET;
if(expected || !args.includes('--no-builtin-tools') || !args.includes('--no-extensions') || !args.includes('--no-session') || args.includes('bash')) process.exit(4);
let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{
if(!text.includes('$(touch unsafe)')) process.exit(5);
console.log(${JSON.stringify(event([message]))});
});`,
  );
  chmodSync(file, 0o700);
  const adapter = new CliAdapter(
    { id: "pi", runtime: "pi", executable: file },
    root,
    2000,
  );
  const input = {
    id: "run",
    cwd: root,
    prompt: "$(touch unsafe)",
    allowWrites: false,
    peers: [],
    signal: new AbortController().signal,
  };
  process.env.EASY_LARKY_TEST_SECRET = "must-not-inherit";
  try {
    assert.equal((await adapter.execute(input)).decision.text, "ok");
  } finally {
    delete process.env.EASY_LARKY_TEST_SECRET;
  }
  writeFileSync(file, "#!/usr/bin/env node\nsetInterval(()=>{},1000);");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(
    adapter.execute({ ...input, signal: controller.signal }),
    /cancelled/,
  );
  const short = new CliAdapter(adapter.agent, root, 40);
  await assert.rejects(short.execute(input), /runtime_timeout/);
});

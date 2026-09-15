import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LarkToolRunner,
  toolCommand,
  rawRead,
  redactToolOutput,
  type CliProcess,
} from "../src/lark-tools.js";
import { configSchema } from "../src/config.js";
const bot = configSchema.parse({
  version: 1,
  stateDir: "unused",
  agents: [],
  projects: [],
  bindings: [],
  bots: [
    {
      id: "bot",
      agentId: "agent",
      appId: "cli_test",
      appType: "custom",
      appSecretEnv: "EASY_TOOL_TEST_SECRET",
      tenant: "feishu",
      tenantKey: "tenant",
      selfOpenId: "ou_bot",
    },
  ],
}).bots[0];
function runner(t: any, run: CliProcess) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easy-tools-test-"));
  process.env.EASY_TOOL_TEST_SECRET = "private_test_secret";
  t.after(() => {
    delete process.env.EASY_TOOL_TEST_SECRET;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    runner: new LarkToolRunner(dir, run, async () => "private_bot_token"),
    dir,
    context: { signal: new AbortController().signal },
  };
}
test("CLI identity and execution environment are per call and never inherit operator tokens", async (t) => {
  let calls = 0;
  const s = runner(t, async (args, env, cwd) => {
    calls++;
    assert.equal(env.LARKSUITE_CLI_APP_ID, bot.appId);
    assert.equal(env.HOME, cwd);
    assert.equal(env.LARKSUITE_CLI_CONFIG_DIR, cwd);
    assert.equal(env.LARKSUITE_CLI_USER_ACCESS_TOKEN, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    if (args.at(-1) === "--help") {
      assert.equal(env.LARKSUITE_CLI_APP_SECRET, undefined);
      return { code: 0, stdout: "Risk: read\n", stderr: "" };
    }
    assert.deepEqual(args.slice(-2), ["--as", "bot"]);
    assert.equal(env.LARKSUITE_CLI_APP_SECRET, undefined);
    assert.equal(env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN, "private_bot_token");
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { name: "真实返回" } }),
      stderr: "",
    };
  });
  const result = await s.runner.execute(
    bot,
    { argv: ["calendar", "calendars", "list"] },
    s.context,
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /真实返回/);
  assert.equal(calls, 2);
  assert.deepEqual(readdirSync(s.dir), []);
});
test("discovery supports embedded references without credentials; identity overrides and unsafe paths rejected", async (t) => {
  const s = runner(t, async (args, env) => {
    assert.equal(env.LARKSUITE_CLI_APP_SECRET, undefined);
    return { code: 0, stdout: "Skill reference", stderr: "" };
  });
  assert.equal(
    (
      await s.runner.execute(
        bot,
        { argv: ["skills", "read", "lark-doc/references/lark-doc-create.md"] },
        s.context,
      )
    ).ok,
    true,
  );
  for (const argv of [
    ["auth", "login"],
    ["event", "listen"],
    ["docs", "+fetch", "--as", "user"],
    ["docs", "+fetch", "--profile=x"],
    ["docs", "+fetch", "--output", "x"],
    ["docs", "+fetch", "--data", "@../../secret"],
    ["docs", "+create", "--title", "x", "--help"],
    ["docs", "+create", "--help=true"],
    ["skills", "read", "../../secret"],
  ])
    assert.throws(() => toolCommand(argv));
  assert.equal(toolCommand(["docs", "+create", "--help"]).discovery, true);
  assert.throws(() => rawRead(["api", "POST", "/open-apis/im/v1/messages"]));
  assert.throws(() => rawRead(["api", "GET", "https://evil.test"]));
  assert.throws(() => rawRead(["api", "GET", "/open-apis/auth/v3/token"]));
  assert.throws(() =>
    rawRead(["api", "GET", "/open-apis/contact/v3/users", "--as", "user"]),
  );
  assert.equal(rawRead(["api", "GET", "/open-apis/contact/v3/scopes"]), true);
});
test("business write previews first; destructive confirmation adds yes only after approval", async (t) => {
  const argsSeen: string[][] = [];
  const s = runner(t, async (args) => {
    argsSeen.push(args);
    return {
      code: 0,
      stdout:
        args.at(-1) === "--help"
          ? "Risk: high-risk-write\n--dry-run\n"
          : JSON.stringify({
              ok: true,
              dry_run: args.includes("--dry-run"),
              data: { id: "record" },
            }),
      stderr: "",
    };
  });
  const request = { argv: ["sheets", "+delete", "--spreadsheet-id", "sheet"] };
  const preview = await s.runner.execute(bot, request, s.context);
  assert.equal(preview.confirmationRequired, true);
  assert.equal(argsSeen.at(-1)?.includes("--yes"), false);
  assert.equal(argsSeen.at(-1)?.at(-1), "--dry-run");
  const result = await s.runner.execute(bot, request, {
    ...s.context,
    approved: true,
  });
  assert.equal(result.confirmationRequired, undefined);
  assert.equal(argsSeen.at(-1)?.at(-1), "--yes");
  assert.equal(argsSeen.at(-1)?.includes("--dry-run"), false);
});
test("unknown risk and messaging writes never reach business execution; errors stay errors and redact secrets", async (t) => {
  let count = 0;
  let help = "Risk: write\n--dry-run\n";
  const s = runner(t, async (args) => {
    count++;
    return args.at(-1) === "--help"
      ? { code: 0, stdout: help, stderr: "" }
      : {
          code: 1,
          stdout: "",
          stderr: '{"ok":false,"error":{"message":"private_test_secret"}}',
        };
  });
  assert.equal(
    (
      await s.runner.execute(
        bot,
        { argv: ["im", "+messages-send", "--text", "hi"] },
        s.context,
      )
    ).ok,
    false,
  );
  assert.equal(count, 1);
  help = "no risk";
  assert.equal(
    (await s.runner.execute(bot, { argv: ["docs", "+create"] }, s.context)).ok,
    false,
  );
  assert.equal(count, 2);
  help = "Risk: read\n";
  const failed = await s.runner.execute(
    bot,
    { argv: ["docs", "+fetch", "--doc", "doc"] },
    s.context,
  );
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.output, /private_test_secret/);
  assert.equal(
    redactToolOutput('{"access_token":"secret"}'),
    '{"access_token":"[REDACTED]"}',
  );
});
test("cancelled requests do not spawn; large successful outputs expose truncation", async (t) => {
  let count = 0;
  const s = runner(t, async () => {
    count++;
    return { code: 0, stdout: "x".repeat(25000), stderr: "" };
  });
  const c = new AbortController();
  c.abort();
  assert.equal(
    (await s.runner.execute(bot, { argv: ["--help"] }, { signal: c.signal }))
      .ok,
    false,
  );
  assert.equal(count, 0);
  const result = await s.runner.execute(bot, { argv: ["--help"] }, s.context);
  assert.equal(result.truncated, true);
  assert.equal(result.output.length, 24000);
});

test("write success requires an actual receipt, and missing permissions retain recovery details", async (t) => {
  let output = "plain text is not a write receipt",
    code = 0;
  const s = runner(t, async (args) =>
    args.at(-1) === "--help"
      ? { code: 0, stdout: "Risk: write\n--dry-run\n", stderr: "" }
      : {
          code,
          stdout: code === 0 ? output : "",
          stderr: code !== 0 ? output : "",
        },
  );
  const request = { argv: ["docs", "+create", "--title", "test"] };
  assert.equal((await s.runner.execute(bot, request, s.context)).ok, false);
  output =
    '{"ok":false,"error":{"subtype":"missing_scope","missing_scopes":["docx:document:write_only"]}}';
  code = 1;
  const failure = await s.runner.execute(bot, request, {
    ...s.context,
    approved: true,
  });
  assert.equal(failure.ok, false);
  assert.match(failure.output, /missing_scope/);
});

test("official CLI subprocess cancellation terminates execution and bounded output fails explicitly", async (t) => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const { runCliProcess } = await import("../src/lark-tools.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "tool-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "lark-cli");
  writeFileSync(
    file,
    "#!/usr/bin/env node\nif(process.argv.includes('large')) process.stdout.write('x'.repeat(200000)); else setInterval(()=>{},1000);\n",
  );
  chmodSync(file, 0o700);
  const env = { PATH: dir + path.delimiter + process.env.PATH, HOME: dir };
  const c = new AbortController();
  const pending = runCliProcess([], env, dir, c.signal);
  setTimeout(() => c.abort(), 80);
  await assert.rejects(pending, /tool_cancelled/);
  await assert.rejects(
    runCliProcess(["large"], env, dir, new AbortController().signal),
    /tool_output_limit/,
  );
});

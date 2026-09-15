import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  browseDirectories,
  ModelCatalog,
  parseCodexModels,
  parseModelList,
} from "../src/local-options.js";

test("directory browser lists only folders, supports hidden folders and canonicalizes selection", async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lark-folder-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "项目 空格"));
  mkdirSync(path.join(dir, ".private"));
  writeFileSync(path.join(dir, "credential.txt"), "never-return-file-body");
  symlinkSync(path.join(dir, "项目 空格"), path.join(dir, "shortcut"));
  const listing = await browseDirectories({ path: dir });
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ["项目 空格"],
  );
  assert.equal(listing.parent, path.dirname(dir));
  assert.equal(JSON.stringify(listing).includes("credential"), false);
  assert.equal(
    (await browseDirectories({ path: dir, hidden: true })).entries.length,
    2,
  );
  assert.equal(
    (await browseDirectories({ path: path.join(dir, "shortcut") })).path,
    path.join(dir, "项目 空格"),
  );
  await assert.rejects(
    browseDirectories({ path: path.join(dir, "credential.txt") }),
    /directory_unavailable/,
  );
  await assert.rejects(
    browseDirectories({ path: path.join(dir, "missing") }),
    /directory_unavailable/,
  );
});

test("model catalogs preserve provider identities, exclude hidden Codex entries and discard diagnostics", () => {
  assert.deepEqual(
    parseModelList(
      "pi",
      "provider model context max-out\nalpha shared 128K 16K yes\nbeta shared 32K 8K no\nerror token=do-not-return",
    ),
    [
      { value: "alpha/shared", label: "alpha/shared" },
      { value: "beta/shared", label: "beta/shared" },
    ],
  );
  assert.deepEqual(
    parseModelList(
      "grok",
      "You are not authenticated.\nDefault model: grok-test\nAvailable models:\n  * grok-test (default)\n  - grok-other\n",
    ).map((m) => m.value),
    ["grok-test", "grok-other"],
  );
  assert.deepEqual(
    parseCodexModels({
      models: [
        { slug: "valid-model", display_name: "Model", visibility: "list" },
        { slug: "hidden", visibility: "hide" },
        { slug: "--unsafe", visibility: "list" },
        null,
      ],
    }),
    [{ value: "valid-model", label: "Model" }],
  );
  assert.deepEqual(parseCodexModels({ models: "invalid" }), []);
});

test("model discovery coalesces concurrent calls and failures return a safe editable fallback", async () => {
  let calls = 0;
  const catalog = new ModelCatalog(async () => {
    calls++;
    throw new Error("private provider error");
  });
  const agent = { id: "pi", runtime: "pi" as const, executable: "pi" };
  const values = await Promise.all([catalog.get(agent), catalog.get(agent)]);
  assert.equal(calls, 1);
  assert.deepEqual(values, [
    { models: [], source: "unavailable" },
    { models: [], source: "unavailable" },
  ]);
});

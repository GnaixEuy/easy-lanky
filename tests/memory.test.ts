import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import { MemoryStore } from "../src/memory.js";
function setup(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easy-larky-memory-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    memory: new MemoryStore(store),
    scope: { projectId: "p", userId: null, agentId: null },
  };
}
test("project/user/agent isolation and budget apply to both runtime views", (t) => {
  const { memory, scope } = setup(t);
  memory.remember(scope, "shared", "project fact", "user-message");
  memory.remember(
    { ...scope, userId: "alice" },
    "private",
    "private preference",
    "user-message",
  );
  memory.remember(
    { ...scope, agentId: "grok" },
    "role",
    "grok role",
    "user-message",
  );
  for (const agentId of ["chatgpt", "grok"]) {
    const items = memory.retrieve({ ...scope, agentId }, "fact");
    assert.ok(items.some((m) => m.key === "shared"));
    assert.ok(!items.some((m) => m.key === "private"));
  }
  assert.equal(memory.retrieve({ ...scope, projectId: "q" }, "fact").length, 0);
  assert.equal(memory.retrieve(scope, "fact", 1).length, 0);
  assert.ok(
    memory
      .retrieve({ ...scope, userId: "alice" }, "private")
      .some((m) => m.key === "private"),
  );
});
test("correction version and forget tombstone prevent stale overwrite and resurrection", (t) => {
  const { memory, scope } = setup(t);
  let item = memory.remember(scope, "style", "old", "m1");
  assert.throws(
    () => memory.remember(scope, "style", "racing", "m2"),
    /version_conflict/,
  );
  item = memory.remember(
    scope,
    "style",
    "new, preserve exceptions",
    "m2",
    item.version,
  );
  assert.equal(
    memory.retrieve(scope, "style")[0].text,
    "new, preserve exceptions",
  );
  memory.forget(scope, "style", item.version);
  assert.equal(memory.retrieve(scope, "style").length, 0);
  assert.equal(memory.get(scope, "style")?.text, "");
  assert.equal(memory.get(scope, "style")?.source, "");
  assert.throws(
    () => memory.remember(scope, "style", "resurrect", "m3", 3),
    /forgotten_key/,
  );
});
test("consolidation interface rejects stale generation; candidates do not become facts", (t) => {
  const { memory, scope } = setup(t);
  const snap = memory.snapshot(scope);
  memory.remember(scope, "fact", "explicit", "m1");
  assert.throws(
    () =>
      memory.publishCandidates(scope, snap.generation, [
        { key: "stale", text: "wrong", source: "m0" },
      ]),
    /generation_conflict/,
  );
  memory.publishCandidates(scope, memory.snapshot(scope).generation, [
    { key: "candidate", text: "inferred", source: "m2" },
  ]);
  assert.equal(
    memory.retrieve(scope, "inferred").some((m) => m.key === "candidate"),
    false,
  );
});
test("nested transaction rollback does not leak partial memory candidates", (t) => {
  const { memory, scope } = setup(t);
  assert.throws(() =>
    memory.publishCandidates(scope, 0, [
      { key: "one", text: "one", source: "m1" },
      { key: "one", text: "two", source: "m2" },
    ]),
  );
  assert.equal(memory.visible(scope, true).length, 0);
  assert.equal(memory.snapshot(scope).generation, 0);
});
test("secrets are rejected and audit only contains metadata after forgetting", (t) => {
  const { memory, scope, store } = setup(t);
  assert.throws(
    () => memory.remember(scope, "secret", "api_key=secret-value", "m"),
    /secret_rejected/,
  );
  const m = memory.remember(scope, "fact", "test confidential", "m");
  memory.forget(scope, "fact", m.version);
  const rows = JSON.stringify(
    store.db.prepare("SELECT * FROM memory_revisions").all(),
  );
  assert.equal(rows.includes("confidential"), false);
});

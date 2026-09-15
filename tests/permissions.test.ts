import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PermissionService } from "../src/permissions.js";
import { requiredTenantScopes } from "../src/permissions-manifest.js";
function fixture(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "easy-larky-scopes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let rows: any[] = requiredTenantScopes.map((scope_name) => ({
    scope_name,
    grant_status: 2,
    scope_type: "tenant",
  }));
  let code = 0,
    lost = false,
    applied = 0;
  const request = (async (url: any, init: any) => {
    const route = String(url);
    assert.equal(init.redirect, "error");
    if (route.endsWith("/internal"))
      return Response.json({ code: 0, tenant_access_token: "secret-token" });
    if (route.endsWith("/apply")) {
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined); // Official apply has no scope selector.
      applied++;
      if (lost) throw new Error("private network trace");
      return Response.json(
        { code, msg: "private provider response" },
        { status: code ? 400 : 200 },
      );
    }
    return Response.json({ code: 0, data: { scopes: rows } });
  }) as typeof fetch;
  const file = path.join(dir, "host.local.json");
  const service = () => new PermissionService(file, request);
  return {
    file,
    service,
    setRows: (next: any[]) => {
      rows = next;
    },
    setCode: (next: number) => {
      code = next;
    },
    lose: () => {
      lost = true;
    },
    applied: () => applied,
  };
}

test("only actual tenant grants count; undeclared scopes require configuration before any admin application", async (t) => {
  const f = fixture(t);
  f.setRows(
    requiredTenantScopes.map((scope_name) => ({
      scope_name,
      grant_status: 1,
      scope_type: "user",
    })),
  );
  const result = await f.service().ensure("feishu", "cli_fixture", "secret");
  assert.equal(result.status, "configuration_required");
  assert.deepEqual(result.undeclared, requiredTenantScopes);
  assert.equal(f.applied(), 0);
});
test("approval is submitted once across restarts and only real granted status unlocks readiness", async (t) => {
  const f = fixture(t);
  assert.equal(
    (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
    "submitted",
  );
  assert.equal(
    (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
    "submitted",
  );
  assert.equal(f.applied(), 1);
  assert.equal(
    statSync(f.file + ".permissions.local.json").mode & 0o777,
    0o600,
  );
  assert.doesNotMatch(
    readFileSync(f.file + ".permissions.local.json", "utf8"),
    /secret|private/,
  );
  f.setRows(
    requiredTenantScopes.map((scope_name) => ({
      scope_name,
      grant_status: 1,
      scope_type: "tenant",
    })),
  );
  assert.equal(
    (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
    "granted",
  );
  assert.equal(f.applied(), 1);
});
test("ambiguous apply response is never blindly retried after restart", async (t) => {
  const f = fixture(t);
  f.lose();
  assert.equal(
    (await f.service().ensure("lark", "cli_fixture", "secret")).status,
    "unknown",
  );
  assert.equal(
    (await f.service().ensure("lark", "cli_fixture", "secret")).status,
    "unknown",
  );
  assert.equal(f.applied(), 1);
});
test("duplicate, approval limit, sensitive scopes and empty applications stay distinct", async (t) => {
  for (const [code, status] of [
    [212004, "pending"],
    [212003, "limited"],
    [212001, "sensitive"],
    [212002, "unverified"],
  ] as const) {
    const f = fixture(t);
    f.setCode(code);
    assert.equal(
      (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
      status,
    );
    assert.equal(
      (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
      status,
    );
    assert.equal(f.applied(), 1);
  }
});
test("the all-pending apply endpoint cannot submit unrelated user or business scopes", async (t) => {
  const f = fixture(t);
  f.setRows([
    ...requiredTenantScopes.map((scope_name) => ({
      scope_name,
      grant_status: 2,
      scope_type: "tenant",
    })),
    {
      scope_name: "mail:user_mailbox.message:send",
      grant_status: 2,
      scope_type: "user",
    },
  ]);
  assert.equal(
    (await f.service().ensure("feishu", "cli_fixture", "secret")).status,
    "external_pending",
  );
  assert.equal(f.applied(), 0);
});

test("API grants do not imply full directory visibility; scope counts follow pagination", async () => {
  const { inspectDirectoryScope } = await import("../src/permissions.js");
  const data = await inspectDirectoryScope(async (route) => ({
    code: 0,
    data: route.includes("page_token=")
      ? { user_ids: ["ou_b"], department_ids: [] }
      : { user_ids: ["ou_a"], has_more: true, page_token: "next" },
  }));
  assert.equal(data.status, "checked");
  assert.equal(data.users, 2);
  assert.equal(data.allDepartments, false);
  assert.equal(
    (
      await inspectDirectoryScope(async () => {
        throw new Error("permission");
      })
    ).status,
    "unavailable",
  );
});

test("read-only readiness check never submits pending permissions", async (t) => {
  const f = fixture(t);
  const state = await f
    .service()
    .ensure("feishu", "cli_fixture", "secret", false);
  assert.equal(state.status, "pending");
  assert.equal(f.applied(), 0);
  assert.equal(state.availability?.status, "unavailable");
  assert.equal(state.directory?.status, "unavailable");
});

test("app availability is independent of grants, validates pagination and never infers all from count", async () => {
  const { inspectAppAvailability } = await import("../src/permissions.js");
  const all = await inspectAppAvailability(
    async () => ({ data: { is_visible_to_all: 1 } }),
    "app",
  );
  assert.equal(all.status, "checked");
  assert.equal(all.allMembers, true);
  const partial = await inspectAppAvailability(
    async (route) => ({
      data: route.includes("user_page_token=")
        ? { is_visible_to_all: 0, users: [{ open_id: "b" }] }
        : {
            is_visible_to_all: 0,
            users: [{ open_id: "a" }],
            has_more_users: 1,
            user_page_token: "next",
          },
    }),
    "app",
  );
  assert.equal(partial.users, 2);
  assert.equal(partial.allMembers, false);
  assert.equal(partial.truncated, false);
  const invalid = await inspectAppAvailability(
    async () => ({ data: { is_visible_to_all: "1" } }),
    "app",
  );
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.allMembers, false);
});

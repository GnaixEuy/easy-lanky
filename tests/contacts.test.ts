import test from "node:test";
import assert from "node:assert/strict";
import { findContacts } from "../src/contacts.js";
test("directory resolves only scoped people, walks paginated departments and preserves duplicate names", async () => {
  const paths: string[] = [];
  const result = await findContacts(async (route) => {
    paths.push(route);
    let data: any;
    if (route.startsWith("contact/v3/scopes"))
      data = { user_ids: ["ou_user"], department_ids: ["root"] };
    else if (route.startsWith("contact/v3/users/ou_user"))
      data = { user: { open_id: "ou_user", name: "宇翔" } };
    else if (route.includes("find_by_department"))
      data = {
        items: [
          { open_id: "ou_other", name: "苏宇翔" },
          {
            open_id: "ou_departed",
            name: "宇翔",
            status: { is_resigned: true },
          },
        ],
      };
    else if (route.includes("page_token=next")) data = { items: [] };
    else data = { items: [], has_more: true, page_token: "next" };
    return { code: 0, data };
  }, "宇翔");
  assert.deepEqual(
    result.contacts.map((c) => c.openId),
    ["ou_user", "ou_other"],
  );
  assert.equal(result.incomplete, false);
  assert.ok(paths.some((p) => p.includes("page_token=next")));
  assert.ok(paths.every((p) => !p.includes("department_id=0")));
});
test("directory failure does not masquerade as no matches and repeated pagination fails closed", async () => {
  await assert.rejects(
    findContacts(async () => {
      throw new Error("lark_permission_required");
    }, "用户"),
    /permission/,
  );
  await assert.rejects(
    findContacts(
      async () => ({ code: 0, data: { has_more: true, page_token: "same" } }),
      "用户",
    ),
    /directory_response_invalid/,
  );
  const result = await findContacts(
    async () => ({ code: 0, data: { user_ids: [], group_ids: ["group"] } }),
    "用户",
  );
  assert.equal(result.incomplete, true);
});
test("explicit open_id is checked in this application's directory", async () => {
  let calls = 0;
  const result = await findContacts(async (route) => {
    calls++;
    assert.equal(route, "contact/v3/users/ou_exact?user_id_type=open_id");
    return { code: 0, data: { user: { open_id: "ou_exact", name: "用户" } } };
  }, "ou_exact");
  assert.equal(calls, 1);
  assert.equal(result.contacts[0].openId, "ou_exact");
});

test("missing user names indicates field permission failure, not an empty search result", async () => {
  await assert.rejects(
    findContacts(
      async (route) => ({
        code: 0,
        data: route.includes("scopes")
          ? { user_ids: ["ou_user"] }
          : { user: { open_id: "ou_user" } },
      }),
      "宇翔",
    ),
    /directory_name_permission_required/,
  );
});

test("standalone directory lists and pages visible contacts without a recipient query", async () => {
  const { listContacts } = await import("../src/contacts.js");
  const read = async (route: string) => ({
    code: 0,
    data: route.includes("scopes")
      ? { user_ids: ["ou_a", "ou_b", "ou_c"] }
      : {
          user: {
            open_id: route.includes("ou_a")
              ? "ou_a"
              : route.includes("ou_b")
                ? "ou_b"
                : "ou_c",
            name: "可见用户",
          },
        },
  });
  const first = await listContacts(read, "", 0, 2);
  assert.equal(first.contacts.length, 2);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.incomplete, false);
  const last = await listContacts(read, "", first.nextOffset!, 2);
  assert.deepEqual(
    last.contacts.map((x) => x.openId),
    ["ou_c"],
  );
  assert.equal(last.nextOffset, null);
  await assert.rejects(listContacts(read, "", -1), /invalid_contact_query/);
});

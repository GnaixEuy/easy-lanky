import test from "node:test";
import assert from "node:assert/strict";
import { discoverBot } from "../src/bot-setup.js";
test("identity discovery uses only selected first-party endpoints and rejects missing identity", async () => {
  const urls: string[] = [];
  const fixture = (async (url: any, init: any) => {
    urls.push(String(url));
    assert.equal(init.redirect, "error");
    const body =
      urls.length === 1
        ? { code: 0, tenant_access_token: "private-token" }
        : urls.length === 2
          ? { code: 0, bot: { open_id: "open_fixture" } }
          : { code: 0, data: { tenant: { tenant_key: "tenant_fixture" } } };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  assert.deepEqual(
    await discoverBot("feishu", "app_fixture", "secret_fixture", fixture),
    { openId: "open_fixture", tenantKey: "tenant_fixture" },
  );
  assert.deepEqual(urls, [
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    "https://open.feishu.cn/open-apis/bot/v3/info",
    "https://open.feishu.cn/open-apis/tenant/v2/tenant/query",
  ]);
  await assert.rejects(
    discoverBot(
      "lark",
      "app",
      "secret",
      async () => new Response(JSON.stringify({ code: 0 })),
    ),
    /lark_credentials_rejected/,
  );
});
test("provider errors never leak supplied secrets or raw response bodies", async () => {
  await assert.rejects(
    discoverBot("feishu", "app", "secret_fixture", async () => {
      throw new Error("secret_fixture server traceback");
    }),
    (e) => e instanceof Error && e.message === "lark_network_unavailable",
  );
});

const permissionFixture = (tenantReply: unknown, status = 400) =>
  (async (url: any) => {
    const route = String(url);
    return new Response(
      JSON.stringify(
        route.includes("auth/v3/")
          ? { code: 0, tenant_access_token: "private-token" }
          : route.includes("bot/v3/")
            ? { code: 0, bot: { open_id: "fixture" } }
            : tenantReply,
      ),
      { status: route.includes("tenant/v2/") ? status : 200 },
    );
  }) as typeof fetch;

test("real tenant permission error is actionable without leaking upstream text", async () => {
  await assert.rejects(
    discoverBot(
      "feishu",
      "fixture",
      "secret_fixture",
      permissionFixture({
        code: 99991672,
        msg: "secret_fixture https://untrusted.invalid/authorize",
        error: {
          permission_violations: [
            {
              type: "action_scope_required",
              subject: "tenant:tenant:readonly",
            },
          ],
        },
      }),
    ),
    (e) =>
      e instanceof Error &&
      e.message === "lark_tenant_permission_required" &&
      !JSON.stringify(e).includes("secret_fixture"),
  );
});

test("unrecognized permissions, invalid responses and missing tenant identity do not become successful saves", async () => {
  for (const [body, status, code] of [
    [
      {
        code: 99991672,
        error: {
          permission_violations: [
            { type: "action_scope_required", subject: "untrusted:scope" },
          ],
        },
      },
      400,
      "lark_permission_required",
    ],
    [
      { code: 99991672, error: { permission_violations: {} } },
      400,
      "lark_permission_required",
    ],
    [{ code: 1184001 }, 403, "lark_tenant_unavailable"],
    [{ code: 0, data: { tenant: {} } }, 200, "lark_tenant_unavailable"],
    [null, 502, "lark_response_invalid"],
  ] as const) {
    await assert.rejects(
      discoverBot(
        "feishu",
        "fixture",
        "secret",
        permissionFixture(body, status),
      ),
      (e) => e instanceof Error && e.message === code,
    );
  }
  await assert.rejects(
    discoverBot(
      "feishu",
      "fixture",
      "secret",
      async () => new Response("private gateway details", { status: 502 }),
    ),
    /lark_response_invalid/,
  );
});

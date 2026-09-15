import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupError } from "../src/client/SetupError.js";

test("permission recovery targets only the selected app on its official platform", () => {
  const render = (
    code: string,
    appId = "cli_fixture",
    tenant: "feishu" | "lark" = "feishu",
  ) =>
    renderToStaticMarkup(
      React.createElement(SetupError, {
        error: new Error(code),
        appId,
        tenant,
      }),
    );
  const feishu = render("lark_tenant_permission_required");
  assert.match(feishu, /tenant:tenant:readonly/);
  assert.match(
    feishu,
    /https:\/\/open.feishu.cn\/app\/cli_fixture\/auth\?q=tenant%3Atenant%3Areadonly/,
  );
  assert.match(feishu, /target="_blank" rel="noreferrer"/);
  assert.match(
    render("lark_tenant_permission_required", "cli_fixture", "lark"),
    /https:\/\/open.larksuite.com\/app\/cli_fixture\/auth/,
  );
  assert.doesNotMatch(render("lark_network_unavailable"), /href=/);
  assert.doesNotMatch(
    render("lark_tenant_permission_required", "../unsafe"),
    /href=/,
  );
});

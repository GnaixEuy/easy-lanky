import { gzipSync } from "node:zlib";
import {
  requiredTenantScopes,
  requiredTenantEvents,
} from "./permissions-manifest.js";

// Wire encoding and public URL options from @larksuiteoapi/node-sdk registerApp.
// Keep our persisted device polling; encode only the SDK's documented addons contract.
export function registrationLink(
  raw: string,
  name: string,
  appId?: string,
  scopes: readonly string[] = requiredTenantScopes,
) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    ![
      "open.feishu.cn",
      "open.larksuite.com",
      "accounts.feishu.cn",
      "accounts.larksuite.com",
    ].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("registration_unavailable");
  const addons = {
    // Keep the platform's full default agent template and add our managed
    // capabilities. Do not discard it in favour of a minimal bot template.
    preset: true,
    scopes: { tenant: [...new Set([...requiredTenantScopes, ...scopes])] },
    events: { items: { tenant: requiredTenantEvents } },
  };
  url.searchParams.set("from", "sdk");
  url.searchParams.set("source", "node-sdk/easy-larky");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("name", name);
  url.searchParams.set(
    "addons",
    gzipSync(Buffer.from(JSON.stringify(addons))).toString("base64url"),
  );
  if (appId) {
    url.searchParams.delete("createOnly");
    url.searchParams.set("clientID", appId);
  } else {
    url.searchParams.delete("clientID");
    url.searchParams.set("createOnly", "true");
  }
  return url.toString();
}

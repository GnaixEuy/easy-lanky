import { modelSchema } from "./config.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const robotInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    name: z.string().trim().min(1).max(80),
    agentId: z.string().min(1),
    model: modelSchema.nullable().optional(),
    projectId: z.string().min(1),
    tenant: z.enum(["feishu", "lark"]),
    appId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    secret: z.string().max(1024).optional(),
    revision: z.string().max(128),
  })
  .strict();
export type RobotInput = z.infer<typeof robotInput>;
export class LarkApiError extends Error {
  constructor(
    message: string,
    public providerCode?: number,
  ) {
    super(message);
  }
}
export async function createLarkApi(
  tenant: "feishu" | "lark",
  appId: string,
  secret: string,
  request: typeof fetch = fetch,
) {
  return (await createLarkSession(tenant, appId, secret, request)).call;
}
// Internal credential handoff for official CLI subprocesses. Never serialize the
// session into a model prompt, API response or audit record.
export async function createLarkSession(
  tenant: "feishu" | "lark",
  appId: string,
  secret: string,
  request: typeof fetch = fetch,
) {
  const domain =
    tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  async function call(route: string, init: RequestInit, reason: string) {
    let response: Response;
    try {
      response = await request(domain + "/open-apis/" + route, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error("lark_network_unavailable");
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error("lark_response_invalid");
    }
    if (!data || typeof data !== "object")
      throw new Error("lark_response_invalid");
    // Classify only known provider fields. Never return its message, URLs or tokens.
    if (data.code === 99991672) {
      const violations = data.error?.permission_violations;
      const tenantPermission =
        route === "tenant/v2/tenant/query" &&
        Array.isArray(violations) &&
        violations.some(
          (v: any) =>
            v?.type === "action_scope_required" &&
            v?.subject === "tenant:tenant:readonly",
        );
      throw new Error(
        tenantPermission
          ? "lark_tenant_permission_required"
          : "lark_permission_required",
      );
    }
    if (!response.ok || data.code !== 0)
      throw new LarkApiError(
        reason,
        Number.isInteger(data.code) ? data.code : undefined,
      );
    return data;
  }
  const auth = await call(
    "auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
    },
    "lark_credentials_rejected",
  );
  if (typeof auth.tenant_access_token !== "string" || !auth.tenant_access_token)
    throw new Error("lark_credentials_rejected");
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
  return {
    token: auth.tenant_access_token as string,
    call: (route: string, reason: string, method = "GET") =>
      call(route, { headers, method }, reason),
  };
}
export async function discoverBot(
  tenant: "feishu" | "lark",
  appId: string,
  secret: string,
  request: typeof fetch = fetch,
) {
  const call = await createLarkApi(tenant, appId, secret, request);
  const bot = await call("bot/v3/info", "lark_bot_unavailable");
  const tenantData = await call(
    "tenant/v2/tenant/query",
    "lark_tenant_unavailable",
  );
  const openId = bot.bot?.open_id,
    tenantKey = tenantData.data?.tenant?.tenant_key;
  if (typeof openId !== "string" || !openId)
    throw new Error("lark_bot_unavailable");
  if (typeof tenantKey !== "string" || !tenantKey)
    throw new Error("lark_tenant_unavailable");
  return { openId, tenantKey };
}
export function secretFile(configFile: string) {
  return `${configFile}.secrets.local.json`;
}
export function readSecrets(configFile: string): Record<string, string> {
  const file = secretFile(configFile);
  return existsSync(file)
    ? z
        .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string())
        .parse(JSON.parse(readFileSync(file, "utf8")))
    : {};
}
export function writeSecrets(
  configFile: string,
  secrets: Record<string, string>,
) {
  const file = secretFile(configFile),
    temp = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(secrets) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
}
export function loadSecrets(configFile: string) {
  for (const [key, value] of Object.entries(readSecrets(configFile)))
    if (!process.env[key]) process.env[key] = value;
}

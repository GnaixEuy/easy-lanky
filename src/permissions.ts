import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLarkApi, LarkApiError } from "./bot-setup.js";
import { requiredTenantScopes } from "./permissions-manifest.js";

export const permissionStatusSchema = z.object({
  status: z.enum([
    "granted",
    "configuration_required",
    "submitted",
    "pending",
    "unknown",
    "limited",
    "sensitive",
    "external_pending",
    "unverified",
  ]),
  missing: z.array(z.string()),
  undeclared: z.array(z.string()),
  checkedAt: z.number(),
  availability: z
    .object({
      status: z.enum(["checked", "unavailable"]),
      allMembers: z.boolean(),
      users: z.number(),
      departments: z.number(),
      groups: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
  directory: z
    .object({
      status: z.enum(["checked", "unavailable"]),
      users: z.number(),
      departments: z.number(),
      groups: z.number(),
      allDepartments: z.boolean(),
      truncated: z.boolean(),
    })
    .optional(),
});
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;
const ledgerSchema = z.record(
  z.string(),
  z.object({ status: permissionStatusSchema.shape.status, at: z.number() }),
);
export class PermissionService {
  private ledger: z.infer<typeof ledgerSchema>;
  private busy = new Set<string>();
  private file: string;
  constructor(
    configFile: string,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {
    this.file = configFile + ".permissions.local.json";
    try {
      this.ledger = existsSync(this.file)
        ? ledgerSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
        : {};
    } catch {
      throw new Error("permission_state_unreadable");
    }
  }
  private persist() {
    const temp = this.file + ".tmp-" + randomUUID();
    writeFileSync(temp, JSON.stringify(this.ledger) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, this.file);
  }
  async ensure(
    tenant: "feishu" | "lark",
    appId: string,
    secret: string,
    apply = true,
  ): Promise<PermissionStatus> {
    const key = `${tenant}:${appId}`;
    if (this.busy.has(key)) throw new Error("registration_busy");
    this.busy.add(key);
    try {
      const call = await createLarkApi(tenant, appId, secret, this.request);
      const data = await call(
        "application/v6/scopes",
        "lark_scope_query_failed",
      );
      const rows = z
        .array(
          z.object({
            scope_name: z.string(),
            grant_status: z.union([z.literal(1), z.literal(2)]),
            scope_type: z.string().optional(),
          }),
        )
        .safeParse(data.data?.scopes);
      if (!rows.success) throw new Error("lark_response_invalid");
      const [directory, availability] = await Promise.all([
        inspectDirectoryScope(call),
        inspectAppAvailability(call, appId),
      ]);
      const tenantRows = rows.data.filter(
        (r) => !r.scope_type || r.scope_type === "tenant",
      );
      const granted = new Set(
        tenantRows.filter((r) => r.grant_status === 1).map((r) => r.scope_name),
      );
      // The old broader group/chat grants also satisfy the corresponding read capability.
      if (granted.has("im:chat:readonly") || granted.has("im:chat"))
        granted.add("im:chat:read");
      // Official vc.meeting.get accepts either scope; request the current one for new apps.
      if (granted.has("vc:meeting:readonly"))
        granted.add("vc:meeting.meetingevent:read");
      const declared = new Set(tenantRows.map((r) => r.scope_name));
      const missing = requiredTenantScopes.filter((name) => !granted.has(name));
      const undeclared = missing.filter((name) => !declared.has(name));
      const result = (
        status: PermissionStatus["status"],
      ): PermissionStatus => ({
        status,
        missing,
        undeclared,
        checkedAt: this.now(),
        directory,
        availability,
      });
      if (!missing.length) {
        if (this.ledger[key]) {
          delete this.ledger[key];
          this.persist();
        }
        return result("granted");
      }
      if (undeclared.length) return result("configuration_required");
      if (!apply) return result("pending");
      // The apply endpoint has no scope selector: do not submit unrelated pending grants.
      if (
        rows.data.some(
          (r) =>
            r.grant_status === 2 &&
            (r.scope_type === "user" ||
              !requiredTenantScopes.includes(r.scope_name as any)),
        )
      )
        return result("external_pending");
      if (this.ledger[key]) return result(this.ledger[key].status);
      // Persist before the external side effect. A lost response/restart must not resubmit.
      this.ledger[key] = { status: "unknown", at: this.now() };
      this.persist();
      let status: PermissionStatus["status"] = "submitted";
      try {
        await call(
          "application/v6/scopes/apply",
          "lark_scope_apply_failed",
          "POST",
        );
      } catch (e) {
        const code = e instanceof LarkApiError ? e.providerCode : undefined;
        status =
          code === 212004
            ? "pending"
            : code === 212003
              ? "limited"
              : code === 212001
                ? "sensitive"
                : code === 212002
                  ? "unverified"
                  : "unknown";
      }
      this.ledger[key] = { status, at: this.now() };
      this.persist();
      return result(status);
    } finally {
      this.busy.delete(key);
    }
  }
}

// API grants and contact data scope are independent. Counts contain no identities.
export async function inspectDirectoryScope(
  call: (route: string, reason: string) => Promise<any>,
): Promise<NonNullable<PermissionStatus["directory"]>> {
  const users = new Set<string>(),
    departments = new Set<string>(),
    groups = new Set<string>();
  const visited = new Set<string>();
  let token = "",
    truncated = false;
  try {
    for (let page = 0; page < 20; page++) {
      if (visited.has(token)) throw new Error("invalid_page");
      visited.add(token);
      const r = await call(
        "contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id&page_size=100" +
          (token ? `&page_token=${encodeURIComponent(token)}` : ""),
        "directory_scope_unavailable",
      );
      const data = z
        .object({
          user_ids: z.array(z.string()).optional(),
          department_ids: z.array(z.string()).optional(),
          group_ids: z.array(z.string()).optional(),
          has_more: z.boolean().optional(),
          page_token: z.string().optional(),
        })
        .parse(r.data);
      if (
        ![data.user_ids, data.department_ids, data.group_ids].some(
          Array.isArray,
        )
      )
        throw new Error("invalid_scope");
      data.user_ids?.forEach((id) => users.add(id));
      data.department_ids?.forEach((id) => departments.add(id));
      data.group_ids?.forEach((id) => groups.add(id));
      truncated = !!data.has_more;
      if (!data.has_more) break;
      if (!data.page_token) throw new Error("missing_page");
      token = data.page_token;
    }
    return {
      status: "checked",
      users: users.size,
      departments: departments.size,
      groups: groups.size,
      allDepartments: departments.has("0"),
      truncated,
    };
  } catch {
    return {
      status: "unavailable",
      users: 0,
      departments: 0,
      groups: 0,
      allDepartments: false,
      truncated: true,
    };
  }
}

// App usability and contact visibility are independent. Check both even when
// business scopes are still pending, and never infer all-members from a count.
export async function inspectAppAvailability(
  call: (route: string, reason: string) => Promise<any>,
  appId: string,
): Promise<NonNullable<PermissionStatus["availability"]>> {
  const users = new Set<string>(),
    departments = new Set<string>(),
    groups = new Set<string>();
  const seen = new Set<string>();
  let token = "",
    truncated = false;
  try {
    for (let page = 0; page < 20; page++) {
      if (seen.has(token)) throw new Error("invalid_page");
      seen.add(token);
      const response = await call(
        `application/v2/app/visibility?app_id=${encodeURIComponent(appId)}&user_page_size=100${token ? `&user_page_token=${encodeURIComponent(token)}` : ""}`,
        "app_availability_unavailable",
      );
      const data = z
        .object({
          is_visible_to_all: z.union([z.literal(0), z.literal(1)]),
          has_more_users: z.union([z.literal(0), z.literal(1)]).optional(),
          user_page_token: z.string().optional(),
          users: z.array(z.object({ open_id: z.string() })).optional(),
          departments: z
            .array(z.object({ open_department_id: z.string() }))
            .optional(),
          groups: z.array(z.object({ group_id: z.string() })).optional(),
        })
        .parse(response.data);
      data.users?.forEach((x) => users.add(x.open_id));
      data.departments?.forEach((x) => departments.add(x.open_department_id));
      data.groups?.forEach((x) => groups.add(x.group_id));
      if (data.is_visible_to_all === 1)
        return {
          status: "checked",
          allMembers: true,
          users: users.size,
          departments: departments.size,
          groups: groups.size,
          truncated: false,
        };
      truncated = data.has_more_users === 1;
      if (!truncated) break;
      if (!data.user_page_token) throw new Error("missing_page");
      token = data.user_page_token;
    }
    return {
      status: "checked",
      allMembers: false,
      users: users.size,
      departments: departments.size,
      groups: groups.size,
      truncated,
    };
  } catch {
    return {
      status: "unavailable",
      allMembers: false,
      users: 0,
      departments: 0,
      groups: 0,
      truncated: true,
    };
  }
}

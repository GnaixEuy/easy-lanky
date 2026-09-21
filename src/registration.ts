// Device registration protocol adapted from larksuite/cli (MIT), commit 39aaf9f.
// See THIRD_PARTY_NOTICES.md. Browser responses never contain device codes or credentials.
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import QRCode from "qrcode";
import { z } from "zod";
import { robotInput, discoverBot, readSecrets } from "./bot-setup.js";
import type { ConfigurationManager } from "./configuration.js";

import { PermissionService, permissionStatusSchema } from "./permissions.js";
import { registrationLink } from "./registration-link.js";
import { requiredTenantScopes } from "./permissions-manifest.js";

export const registrationInput = robotInput.omit({ appId: true, secret: true });
const jobSchema = z.object({
  id: z.string(),
  intent: z.enum(["create", "connect"]).default("create"),
  flow: z.enum(["create", "permissions"]).default("create"),
  expectedAppId: z.string().optional(),
  permissionFlowStarted: z.boolean().default(false),
  permissions: permissionStatusSchema.optional(),
  input: registrationInput,
  status: z.enum([
    "pending",
    "ready",
    "saved",
    "cancelled",
    "expired",
    "denied",
    "failed",
  ]),
  deviceCode: z.string().optional(),
  url: z.string().optional(),
  expiresAt: z.number(),
  nextPollAt: z.number(),
  interval: z.number(),
  pollBrand: z.enum(["feishu", "lark"]),
  switched: z.boolean(),
  credentials: z
    .object({
      appId: z.string(),
      secret: z.string(),
      brand: z.enum(["feishu", "lark"]),
    })
    .optional(),
  error: z.string().optional(),
});
type Job = z.infer<typeof jobSchema>;
type Brand = Job["pollBrand"];
export class RegistrationService {
  private jobs = new Map<string, Job>();
  private busy = new Set<string>();
  private file: string;
  constructor(
    private configuration: ConfigurationManager,
    private request: typeof fetch = fetch,
    private now = Date.now,
    private discover = discoverBot,
    private permissions: Pick<
      PermissionService,
      "ensure"
    > = new PermissionService(configuration.file, request, now),
  ) {
    this.file = configuration.file + ".registrations.local.json";
    try {
      if (existsSync(this.file))
        for (const job of z
          .array(jobSchema)
          .parse(JSON.parse(readFileSync(this.file, "utf8"))))
          this.jobs.set(job.id, job);
    } catch {
      throw new Error("registration_state_unreadable");
    }
  }
  private persist() {
    const temp = this.file + ".tmp-" + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify([...this.jobs.values()]) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private expire(job: Job) {
    if (job.status === "pending" && this.now() >= job.expiresAt) {
      job.status = job.credentials ? "ready" : "expired";
      if (job.credentials) job.error = "registration_authorization_expired";
      delete job.deviceCode;
      delete job.url;
      this.persist();
    }
  }
  private get(id: string) {
    this.retireCompletedRegistrations();
    const job = this.jobs.get(id);
    if (!job) throw new Error("registration_not_found");
    this.expire(job);
    return job;
  }
  private async view(job: Job) {
    return {
      id: job.id,
      intent: job.intent,
      flow: job.flow,
      permissions: job.permissions,
      botId: job.input.id,
      name: job.input.name,
      agentId: job.input.agentId,
      model: job.input.model,
      projectId: job.input.projectId,
      tenant: job.credentials?.brand ?? job.input.tenant,
      status: job.status,
      error: job.error,
      expiresAt: job.expiresAt,
      nextPollAt: job.nextPollAt,
      url: job.status === "pending" ? job.url : undefined,
      qr:
        job.status === "pending" && job.url
          ? await QRCode.toDataURL(job.url, { width: 240, margin: 2 })
          : undefined,
      appId: job.credentials?.appId ?? job.expectedAppId,
    };
  }
  private retireCompletedRegistrations() {
    const jobs = [...this.jobs.values()];
    const bots = this.configuration.snapshot().config.bots;
    let changed = false;
    for (const [index, job] of jobs.entries()) {
      if (!["pending", "ready"].includes(job.status)) continue;
      const appId = job.credentials?.appId ?? job.expectedAppId;
      const tenant = job.credentials?.brand ?? job.input.tenant;
      const superseded =
        appId &&
        jobs
          .slice(index + 1)
          .some(
            (other) =>
              other.status === "saved" &&
              (other.expectedAppId ??
                other.credentials?.appId ??
                bots.find((bot) => bot.id === other.input.id)?.appId) ===
                appId &&
              other.input.tenant === tenant,
          );
      const deleted =
        !bots.some((bot) => bot.id === job.input.id) &&
        jobs.some(
          (other) =>
            other.status === "saved" && other.input.id === job.input.id,
        );
      if (!superseded && !deleted) continue;
      // Keep the recovery record, but never offer an obsolete attempt as pending again.
      job.status = "cancelled";
      delete job.deviceCode;
      delete job.url;
      changed = true;
    }
    if (changed) this.persist();
  }
  async list() {
    this.retireCompletedRegistrations();
    for (const job of this.jobs.values()) this.expire(job);
    return Promise.all(
      [...this.jobs.values()]
        .filter((j) => j.status === "pending" || j.status === "ready")
        .map((j) => this.view(j)),
    );
  }
  private async call(brand: Brand, params: Record<string, string>) {
    try {
      const response = await this.request(
        `https://accounts.${brand === "lark" ? "larksuite.com" : "feishu.cn"}/oauth/v1/app/registration`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params),
          redirect: "error",
          signal: AbortSignal.timeout(12000),
        },
      );
      const result = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        (!response.ok && !result.error)
      )
        throw new Error();
      return result as Record<string, any>;
    } catch {
      throw new Error("registration_unavailable");
    }
  }
  async begin(raw: unknown) {
    this.retireCompletedRegistrations();
    const input = registrationInput.parse(raw);
    if (!path.basename(this.configuration.file).includes(".local."))
      throw new Error("local_config_file_required");
    const current = this.configuration.snapshot();
    if (input.revision !== current.revision)
      throw new Error("config_revision_conflict");
    if (
      !current.config.agents.some((a) => a.id === input.agentId) ||
      !current.config.projects.some((p) => p.id === input.projectId)
    )
      throw new Error("invalid_local_scope");
    if (current.config.bots.some((b) => b.id === input.id))
      throw new Error("registration_new_robot_required");
    for (const j of this.jobs.values()) {
      this.expire(j);
      if (
        j.input.id === input.id &&
        (j.status === "pending" || j.status === "ready")
      ) {
        if (JSON.stringify(j.input) !== JSON.stringify(input))
          throw new Error("message_id_conflict");
        return this.view(j);
      }
    }
    // Reserve a slot before network I/O so repeated begin requests cannot create parallel sessions.
    if (this.busy.has(input.id)) throw new Error("registration_busy");
    if (
      [...this.jobs.values()].filter(
        (j) => j.status === "pending" || j.status === "ready",
      ).length >= 8
    )
      throw new Error("registration_limit");
    this.busy.add(input.id);
    try {
      const job: Job = {
        id: randomUUID(),
        input,
        intent: "create",
        flow: "create",
        permissionFlowStarted: false,
        status: "pending",
        expiresAt: this.now(),
        nextPollAt: this.now(),
        interval: 5000,
        pollBrand: "feishu",
        switched: false,
      };
      await this.startDevice(job);
      this.jobs.set(job.id, job);
      this.persist();
      return this.view(job);
    } finally {
      this.busy.delete(input.id);
    }
  }
  private async startDevice(
    job: Job,
    appId?: string,
    scopes?: readonly string[],
  ) {
    const data = await this.call("feishu", {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    });
    if (
      data.error ||
      typeof data.device_code !== "string" ||
      !data.device_code ||
      typeof data.user_code !== "string" ||
      !data.user_code
    )
      throw new Error("registration_unavailable");
    const host =
      job.input.tenant === "lark" ? "open.larksuite.com" : "open.feishu.cn";
    const raw =
      typeof data.verification_uri_complete === "string"
        ? data.verification_uri_complete
        : `https://${host}/page/cli?user_code=${encodeURIComponent(data.user_code)}`;
    job.url = registrationLink(
      raw,
      job.input.name,
      appId,
      scopes ?? requiredTenantScopes,
    );
    job.deviceCode = data.device_code;
    job.status = "pending";
    job.flow = appId ? "permissions" : "create";
    job.expectedAppId = appId;
    job.pollBrand = "feishu";
    job.switched = false;
    job.interval = Math.max(5, Math.min(60, Number(data.interval) || 5)) * 1000;
    job.expiresAt =
      this.now() +
      Math.max(
        1,
        Math.min(3600, Number(data.expire_in || data.expires_in) || 600),
      ) *
        1000;
    job.nextPollAt = this.now() + job.interval;
    delete job.error;
  }
  async connect(raw: unknown) {
    this.retireCompletedRegistrations();
    const input = robotInput.parse(raw);
    const current = this.configuration.snapshot();
    if (!path.basename(this.configuration.file).includes(".local."))
      throw new Error("local_config_file_required");
    if (current.revision !== input.revision)
      throw new Error("config_revision_conflict");
    if (
      !current.config.agents.some((a) => a.id === input.agentId) ||
      !current.config.projects.some((p) => p.id === input.projectId)
    )
      throw new Error("invalid_local_scope");
    const bot = current.config.bots.find((b) => b.id === input.id);
    if (
      current.config.bots.some(
        (b) => b.id !== input.id && b.appId === input.appId,
      )
    )
      throw new Error("bots_must_use_distinct_apps");
    if (
      bot &&
      (bot.appId !== input.appId || bot.tenant !== input.tenant) &&
      current.config.bindings.some((b) => b.botId === bot.id)
    )
      throw new Error("bot_replacement_requires_review");
    const { appId, secret, ...plain } = input;
    const credential =
      secret ||
      (bot && bot.appId === appId && bot.tenant === input.tenant
        ? readSecrets(this.configuration.file)[bot.appSecretEnv] ||
          process.env[bot.appSecretEnv]
        : "");
    if (!credential) throw new Error("lark_secret_required");
    let job = [...this.jobs.values()].find(
      (j) => j.input.id === input.id && ["pending", "ready"].includes(j.status),
    );
    if (job) {
      if (
        job.credentials?.appId !== appId ||
        JSON.stringify({ ...job.input, revision: input.revision }) !==
          JSON.stringify(plain)
      )
        throw new Error("message_id_conflict");
      if (this.busy.has(job.id)) throw new Error("registration_busy");
      if (job.credentials!.secret !== credential) {
        if (job.status !== "ready" || !job.error)
          throw new Error("message_id_conflict");
        job.credentials!.secret = credential;
        delete job.permissions;
      }
      job.input.revision = input.revision;
      if (job.status === "pending")
        return { registration: await this.view(job), configuration: undefined };
    } else {
      if (
        [...this.jobs.values()].filter((j) =>
          ["pending", "ready"].includes(j.status),
        ).length >= 8
      )
        throw new Error("registration_limit");
      job = {
        id: randomUUID(),
        input: plain,
        intent: "connect",
        flow: "permissions",
        expectedAppId: appId,
        permissionFlowStarted: false,
        status: "ready",
        expiresAt: this.now(),
        nextPollAt: this.now(),
        interval: 5000,
        pollBrand: input.tenant,
        switched: false,
        credentials: { appId, secret: credential, brand: input.tenant },
      };
      this.jobs.set(job.id, job);
    }
    this.persist();
    return this.finish(job.id, input.revision);
  }
  async status(id: string) {
    return this.view(this.get(id));
  }
  async poll(id: string) {
    const job = this.get(id);
    if (
      job.status !== "pending" ||
      this.now() < job.nextPollAt ||
      this.busy.has(id)
    )
      return this.view(job);
    this.busy.add(id);
    try {
      const data = await this.call(job.pollBrand, {
        action: "poll",
        device_code: job.deviceCode!,
      });
      if (
        job.expectedAppId &&
        data.client_id &&
        (data.client_id !== job.expectedAppId ||
          (job.credentials &&
            data.user_info?.tenant_brand &&
            data.user_info.tenant_brand !== job.credentials.brand))
      ) {
        job.status = job.credentials ? "ready" : "failed";
        job.error = "registration_app_mismatch";
        delete job.deviceCode;
        delete job.url;
        this.persist();
        return this.view(job);
      }
      // A user may cancel while the request is in flight. Never resume the cancelled flow.
      if (job.status !== "pending") {
        if (
          typeof data.client_id === "string" &&
          data.client_id &&
          typeof data.client_secret === "string" &&
          data.client_secret &&
          (!data.user_info?.tenant_brand ||
            data.user_info.tenant_brand === job.pollBrand)
        ) {
          job.credentials = {
            appId: data.client_id,
            secret: data.client_secret,
            brand: job.pollBrand,
          };
          job.status = "ready";
          job.error = "registration_cancelled_after_creation";
          this.persist();
        }
        return this.view(job);
      }
      const brand = data.user_info?.tenant_brand;
      if (brand && brand !== "feishu" && brand !== "lark")
        throw new Error("registration_unavailable");
      if (brand && brand !== job.pollBrand) {
        if (job.switched) throw new Error("registration_unavailable");
        job.pollBrand = brand;
        job.switched = true;
        job.nextPollAt = this.now();
        this.persist();
        return this.view(job);
      }
      if (
        !data.error &&
        typeof data.client_id === "string" &&
        data.client_id &&
        typeof data.client_secret === "string" &&
        data.client_secret
      ) {
        job.credentials = {
          appId: data.client_id,
          secret: data.client_secret,
          brand: job.pollBrand,
        };
        job.status = "ready";
        delete job.permissions;
        delete job.deviceCode;
        delete job.url;
        delete job.error;
        this.persist(); // Retain issued credentials before identity lookup or config write, including after restart.
      } else if (data.error === "access_denied") {
        job.status = job.credentials ? "ready" : "denied";
        if (job.credentials) job.error = "registration_authorization_denied";
      } else if (["expired_token", "invalid_grant"].includes(data.error)) {
        job.status = job.credentials ? "ready" : "expired";
        if (job.credentials) job.error = "registration_authorization_expired";
      } else if (
        data.error &&
        !["authorization_pending", "slow_down"].includes(data.error)
      ) {
        job.status = "failed";
        job.error = "registration_unavailable";
      }
      if (data.error === "slow_down")
        job.interval = Math.min(60000, job.interval + 5000);
      job.nextPollAt = this.now() + job.interval;
      if (job.status !== "pending") {
        delete job.deviceCode;
        delete job.url;
      }
      this.persist();
      return this.view(job);
    } catch (e) {
      job.nextPollAt = this.now() + Math.min(60000, job.interval + 5000);
      // Network failures are retryable and do not expose upstream response text.
      job.error = "registration_unavailable";
      this.persist();
      return this.view(job);
    } finally {
      this.busy.delete(id);
    }
  }
  async finish(id: string, revision?: string) {
    const job = this.get(id);
    if (job.status === "saved")
      return {
        registration: await this.view(job),
        configuration: this.configuration.snapshot(),
      };
    if (!["pending", "ready"].includes(job.status) || !job.credentials)
      throw new Error("registration_not_ready");
    if (this.busy.has(id)) throw new Error("registration_busy");
    this.busy.add(id);
    try {
      if (revision) job.input.revision = revision;
      delete job.error;
      if (
        revision ||
        !job.permissions ||
        this.now() - job.permissions.checkedAt >= 10000
      ) {
        job.permissions = await this.permissions.ensure(
          job.credentials.brand,
          job.credentials.appId,
          job.credentials.secret,
        );
        this.persist();
      }
      if (job.permissions.status !== "granted") {
        if (
          job.permissions.status === "configuration_required" &&
          !job.permissionFlowStarted
        ) {
          await this.startDevice(
            job,
            job.credentials.appId,
            job.permissions.missing,
          );
          job.permissionFlowStarted = true;
          this.persist();
        }
        return { registration: await this.view(job), configuration: undefined };
      }
      const result = await this.configuration.saveRobot(
        {
          ...job.input,
          revision: revision ?? job.input.revision,
          appId: job.credentials.appId,
          secret: job.credentials.secret,
          tenant: job.credentials.brand,
        },
        this.discover,
        job.intent === "create" ? "personal-agent" : undefined,
      );
      job.status = "saved";
      job.expectedAppId = job.credentials.appId;
      delete job.credentials;
      delete job.error;
      this.persist();
      return { registration: await this.view(job), configuration: result };
    } catch (e) {
      job.error = e instanceof Error ? e.message : "operation_failed";
      // Only allow known error codes in status; never persist arbitrary exception text.
      if (
        ![
          "registration_unavailable",
          "lark_scope_query_failed",
          "config_revision_conflict",
          "config_change_requires_review",
          "lark_credentials_rejected",
          "lark_bot_unavailable",
          "lark_tenant_unavailable",
          "lark_tenant_permission_required",
          "lark_permission_required",
          "lark_network_unavailable",
          "lark_response_invalid",
          "bots_must_use_distinct_apps",
          "invalid_local_scope",
        ].includes(job.error)
      )
        job.error = "operation_failed";
      this.persist();
      throw new Error(job.error);
    } finally {
      this.busy.delete(id);
    }
  }
  async authorize(id: string) {
    const job = this.get(id);
    if (
      !job.credentials ||
      job.status !== "ready" ||
      job.permissions?.status !== "configuration_required"
    )
      throw new Error("registration_not_ready");
    if (this.busy.has(id)) throw new Error("registration_busy");
    this.busy.add(id);
    try {
      await this.startDevice(
        job,
        job.credentials.appId,
        job.permissions?.missing,
      );
      job.permissionFlowStarted = true;
      this.persist();
      return this.view(job);
    } finally {
      this.busy.delete(id);
    }
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (job.status === "ready" || job.status === "saved")
      throw new Error("registration_already_created");
    job.status = job.credentials ? "ready" : "cancelled";
    if (job.credentials) job.error = "registration_authorization_cancelled";
    delete job.deviceCode;
    delete job.url;
    this.persist();
    return this.view(job);
  }
}

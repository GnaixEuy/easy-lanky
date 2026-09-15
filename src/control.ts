import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Host } from "./host.js";
import type { ConfigurationManager } from "./configuration.js";
import { RegistrationService } from "./registration.js";
import type { ConnectionService } from "./connection.js";
import { browseDirectories, ModelCatalog } from "./local-options.js";
import { robotInput, createLarkApi } from "./bot-setup.js";
import { PermissionService } from "./permissions.js";

const localRequest = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    agentId: z.string().min(1),
    projectId: z.string().min(1),
    prompt: z.string().trim().min(1).max(12000),
    allowWrites: z.boolean(),
  })
  .strict();
function equals(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new Error("json_required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}
export function createControlHandler(options: {
  host: Host;
  token: string;
  offline: boolean;
  connection?: ConnectionService;
  channels: () => unknown;
  onStop: () => void;
  configuration?: ConfigurationManager;
  origin?: string;
}) {
  const { host, token } = options;
  const modelCatalog = new ModelCatalog();
  const permissionService = options.configuration
    ? new PermissionService(options.configuration.file)
    : undefined;
  const registration = options.configuration
    ? new RegistrationService(options.configuration)
    : undefined;
  const origin = options.origin ?? `http://127.0.0.1:${host.config.port}`;
  const authority = new URL(origin).host;
  const tickets = new Map<string, number>(),
    sessions = new Map<string, number>();
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/client.js": ["client.js", "text/javascript; charset=utf-8"],
    "/client.css": ["client.css", "text/css; charset=utf-8"],
  };
  const health = () => ({
    ...host.health(),
    mode: options.connection
      ? options.connection.offline
        ? "offline"
        : "lark"
      : options.offline
        ? "offline"
        : "lark",
    channels: options.channels(),
  });
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status: number, value: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(status).end(JSON.stringify(value));
    };
    try {
      if (
        req.headers.host !== authority ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(403, { error: "origin_rejected" });
        return;
      }
      const route = req.url ?? "";
      if (req.method === "GET" && route === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (req.method === "GET" && assets[route]) {
        const [file, type] = assets[route];
        res.setHeader("Content-Type", type);
        res.end(readFileSync(new URL(`./client/${file}`, import.meta.url)));
        return;
      }
      for (const map of [tickets, sessions])
        for (const [key, expiry] of map)
          if (expiry < Date.now()) map.delete(key);
      if (req.method === "POST" && route === "/api/session") {
        const input = z
          .object({ ticket: z.string().max(128) })
          .strict()
          .parse(await body(req));
        if (!tickets.delete(input.ticket)) {
          json(401, { error: "ticket_expired" });
          return;
        }
        if (sessions.size >= 64) {
          json(429, { error: "session_limit" });
          return;
        }
        const session = randomBytes(32).toString("hex");
        sessions.set(session, Date.now() + 4 * 60 * 60 * 1000);
        json(200, { token: session });
        return;
      }
      const auth = req.headers.authorization ?? "";
      const admin = equals(auth, `Bearer ${token}`);
      const session = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!admin && !sessions.has(session)) {
        json(401, { error: "unauthorized" });
        return;
      }
      if (req.method === "POST" && route === "/api/logout") {
        sessions.delete(session);
        json(200, { status: "disconnected" });
        return;
      }
      if (req.method === "POST" && route === "/api/session-ticket") {
        if (!admin) {
          json(403, { error: "admin_required" });
          return;
        }
        if (tickets.size >= 64) {
          json(429, { error: "ticket_limit" });
          return;
        }
        const ticket = randomBytes(24).toString("hex");
        tickets.set(ticket, Date.now() + 60000);
        json(200, { url: `${origin}/#ticket=${ticket}` });
        return;
      }
      if (req.method === "POST" && route === "/api/directories") {
        const input = z
          .object({
            path: z.string().trim().max(4096).optional(),
            hidden: z.boolean().optional(),
          })
          .strict()
          .parse(await body(req));
        json(200, await browseDirectories(input));
        return;
      }
      if (req.method === "POST" && route === "/api/models") {
        const input = z
          .object({ agentId: z.string().max(100) })
          .strict()
          .parse(await body(req));
        const config = options.configuration?.snapshot().config ?? host.config;
        const agent = config.agents.find((a) => a.id === input.agentId);
        if (!agent) throw new Error("invalid_local_scope");
        json(200, await modelCatalog.get(agent));
        return;
      }
      if (req.method === "GET" && route === "/health") {
        json(200, health());
        return;
      }
      if (req.method === "POST" && route === "/stop") {
        if (!admin) {
          json(403, { error: "admin_required" });
          return;
        }
        json(200, { status: "stopping" });
        options.onStop();
        return;
      }
      if (
        options.connection &&
        route === "/api/connection" &&
        req.method === "GET"
      ) {
        json(200, options.connection.snapshot());
        return;
      }
      if (
        options.connection &&
        route === "/api/connection/connect" &&
        req.method === "POST"
      ) {
        z.object({})
          .strict()
          .parse(await body(req));
        json(200, await options.connection.connect());
        return;
      }
      if (
        options.connection &&
        route === "/api/conversations/authorize" &&
        req.method === "POST"
      ) {
        const input = z
          .object({ id: z.string().uuid(), revision: z.string().max(128) })
          .strict()
          .parse(await body(req));
        json(200, options.connection.authorize(input.id, input.revision));
        return;
      }
      if (
        options.connection &&
        route === "/api/conversations/revoke" &&
        req.method === "POST"
      ) {
        const input = z
          .object({
            bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
            userId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
            revision: z.string().max(128),
          })
          .strict()
          .parse(await body(req));
        json(
          200,
          options.connection.revoke(
            input.bindingId,
            input.userId,
            input.revision,
          ),
        );
        return;
      }
      const permissionCheck = route.match(
        /^\/api\/robots\/([A-Za-z0-9_-]{1,100})\/permissions$/,
      );
      if (permissionService && permissionCheck && req.method === "GET") {
        const bot = host.config.bots.find((b) => b.id === permissionCheck[1]);
        if (!bot) throw new Error("bot_missing");
        const secret = process.env[bot.appSecretEnv];
        if (!secret) throw new Error("lark_credentials_rejected");
        json(
          200,
          await permissionService.ensure(bot.tenant, bot.appId, secret, false),
        );
        return;
      }
      if (
        options.connection &&
        route === "/api/access/users" &&
        req.method === "GET"
      ) {
        const users: { botId: string; userId: string; name?: string }[] = [];
        for (const bot of host.config.bots) {
          const ids = [
            ...new Set(
              host.config.bindings
                .filter((b) => b.botId === bot.id)
                .flatMap((b) => b.allowedUsers),
            ),
          ];
          if (!ids.length) continue;
          let call: Awaited<ReturnType<typeof createLarkApi>> | undefined;
          try {
            call = await createLarkApi(
              bot.tenant,
              bot.appId,
              process.env[bot.appSecretEnv]!,
            );
          } catch {
            /* IDs remain manageable without directory access. */
          }
          for (const userId of ids) {
            let name: string | undefined;
            if (call) {
              try {
                const data = await call(
                  `contact/v3/users/${encodeURIComponent(userId)}?user_id_type=open_id`,
                  "user_name_unavailable",
                );
                if (typeof data.data?.user?.name === "string")
                  name = data.data.user.name.slice(0, 100);
              } catch {
                /* No raw platform error or credential reaches the UI. */
              }
            }
            users.push({ botId: bot.id, userId, name });
          }
        }
        json(200, { users });
        return;
      }
      if (registration && route === "/api/registrations") {
        if (req.method === "GET") {
          json(200, await registration.list());
          return;
        }
        if (req.method === "POST") {
          json(200, await registration.begin(await body(req)));
          return;
        }
      }
      const registrationRoute = route.match(
        /^\/api\/registrations\/([a-f0-9-]{36})(?:\/(poll|finish|cancel|authorize))?$/,
      );
      if (registration && registrationRoute) {
        const [, id, action] = registrationRoute;
        if (req.method === "GET" && !action) {
          json(200, await registration.status(id));
          return;
        }
        if (req.method === "POST" && action) {
          const input = z
            .object({ revision: z.string().max(128).optional() })
            .strict()
            .parse(await body(req));
          json(
            200,
            action === "poll"
              ? await registration.poll(id)
              : action === "authorize"
                ? await registration.authorize(id)
                : action === "cancel"
                  ? await registration.cancel(id)
                  : await registration.finish(id, input.revision),
          );
          return;
        }
      }
      if (
        options.configuration &&
        req.method === "GET" &&
        route === "/api/config"
      ) {
        json(200, options.configuration.snapshot());
        return;
      }
      if (
        options.configuration &&
        req.method === "POST" &&
        route === "/api/robots"
      ) {
        json(
          200,
          await (async () => {
            const result = await registration!.connect(
              robotInput.parse(await body(req)),
            );
            return result.configuration ?? result;
          })(),
        );
        return;
      }
      if (
        options.configuration &&
        req.method === "POST" &&
        route === "/api/config/validate"
      ) {
        const draft = z
          .object({ config: z.unknown() })
          .strict()
          .parse(await body(req));
        options.configuration.validate(draft.config);
        json(200, { status: "valid" });
        return;
      }
      if (
        options.configuration &&
        req.method === "POST" &&
        route === "/api/config"
      ) {
        const draft = z
          .object({ config: z.unknown(), revision: z.string().max(128) })
          .strict()
          .parse(await body(req));
        json(200, options.configuration.save(draft.config, draft.revision));
        return;
      }
      if (req.method === "GET" && route === "/api/state") {
        const runs = host.store.runs();
        json(200, {
          health: health(),
          agents: host.config.agents.map((a) => ({
            id: a.id,
            runtime: a.runtime,
            model: a.model ?? null,
          })),
          projects: host.config.projects.map((p) => ({
            id: p.id,
            name: p.name,
            root: p.root,
          })),
          bindings: host.config.bindings.map((b) => ({
            id: b.id,
            projectId: b.projectId,
            allowSend: b.allowSend,
          })),
          totalRuns: runs.length,
          runs: runs
            .slice(-200)
            .reverse()
            .map((r) => ({
              id: r.id,
              agentId: r.agentId,
              projectId:
                r.local?.projectId ??
                host.config.bindings.find((b) => b.id === r.bindingId)
                  ?.projectId,
              source: r.local ? "local" : "lark",
              title: r.prompt.slice(0, 100),
              state: r.state,
              error: r.error,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            })),
        });
        return;
      }
      if (req.method === "POST" && route === "/api/runs") {
        if (
          options.configuration?.busy ||
          options.configuration?.pendingRestart
        ) {
          json(409, { error: "config_restart_required" });
          return;
        }
        json(200, host.submitLocal(localRequest.parse(await body(req))));
        return;
      }
      const runRoute = route.match(
        /^\/api\/runs\/([A-Za-z0-9_-]{1,100})(\/cancel)?$/,
      );
      if (runRoute && !runRoute[2] && req.method === "GET") {
        const run = host.store.get(runRoute[1]);
        if (!run) {
          json(404, { error: "run_not_found" });
          return;
        }
        json(200, {
          run,
          source: run.local ? "local" : "lark",
          deliveries: host.store
            .deliveries()
            .filter(
              (d) =>
                d.data.replyTo === run.nativeId &&
                d.data.botId ===
                  host.config.bindings.find((b) => b.id === run.bindingId)
                    ?.botId,
            ),
        });
        return;
      }
      if (runRoute?.[2] && req.method === "POST") {
        json(200, host.cancelLocal(runRoute[1]));
        return;
      }
      json(404, { error: "not_found" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "operation_failed";
      const allowed = new Set([
        "connection_busy",
        "connection_not_ready",
        "conversation_expired",
        "lark_connection_failed",
        "no_bots_configured",
        "config_restart_required",
        "lark_scope_query_failed",
        "registration_app_mismatch",
        "registration_unavailable",
        "registration_not_found",
        "registration_not_ready",
        "registration_new_robot_required",
        "registration_busy",
        "registration_limit",
        "registration_already_created",
        "invalid_json",
        "json_required",
        "body_too_large",
        "invalid_local_request",
        "invalid_local_scope",
        "message_id_conflict",
        "queue_full",
        "host_stopping",
        "local_run_required",
        "runtime_location_readonly",
        "agent_project_required",
        "config_revision_conflict",
        "config_change_requires_review",
        "local_config_file_required",
        "duplicate_config_id",
        "bots_must_use_distinct_apps",
        "unknown_bot_agent",
        "invalid_peer",
        "invalid_binding",
        "ambiguous_binding",
        "invalid_allowed_agent",
        "directory_unavailable",
        "project_root_not_directory",
        "project_root_unavailable",
        "lark_secret_required",
        "bot_replacement_requires_review",
        "lark_credentials_rejected",
        "lark_bot_unavailable",
        "lark_tenant_unavailable",
        "lark_tenant_permission_required",
        "lark_permission_required",
        "lark_network_unavailable",
        "lark_response_invalid",
      ]);
      const code =
        error instanceof z.ZodError
          ? "invalid_request"
          : allowed.has(message)
            ? message
            : "operation_failed";
      if (!res.headersSent)
        json(
          code === "queue_full" || code === "message_id_conflict"
            ? 409
            : code === "operation_failed"
              ? 500
              : 400,
          {
            error: code,
            ...(error instanceof z.ZodError
              ? {
                  fields: error.issues.map((i) => ({
                    path: i.path.join("."),
                    message: i.message,
                  })),
                }
              : {}),
          },
        );
      else res.end();
    }
  };
}

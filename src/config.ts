import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const nativeId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const modelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/);
const agentSchema = z
  .object({
    id,
    runtime: z.enum(["codex", "grok", "pi"]),
    executable: z.string().min(1),
    model: modelSchema.optional(),
  })
  .strict();
const botSchema = z
  .object({
    id,
    name: z.string().min(1).max(80).optional(),
    model: modelSchema.optional(),
    projectId: id.optional(),
    agentId: id,
    tenant: z.enum(["feishu", "lark"]),
    tenantKey: z.string().min(1),
    appType: z.enum(["custom", "personal-agent"]),
    appId: nativeId,
    appSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    selfOpenId: nativeId,
    allowedUsers: z.array(nativeId).optional(),
    allowAllUsers: z.boolean().optional(),
    peers: z
      .record(
        id,
        z.object({ senderId: nativeId, mentionId: nativeId }).strict(),
      )
      .default({}),
  })
  .strict();
const bindingSchema = z
  .object({
    id,
    botId: id,
    chatId: nativeId,
    threadId: nativeId.nullable(),
    projectId: id,
    allowedUsers: z.array(nativeId),
    allowedAgents: z.array(id).default([]),
    allowWrites: z.boolean().default(true),
    allowSend: z.boolean().default(false),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    stateDir: z.string().min(1),
    port: z.number().int().min(1024).max(65535).default(4317),
    maxConcurrent: z.number().int().min(1).max(4).default(2),
    maxQueue: z.number().int().min(1).max(100).default(16),
    maxHops: z.number().int().min(1).max(3).default(1),
    maxDelegations: z.number().int().min(1).max(4).default(1),
    runTimeoutMs: z.number().int().min(1000).max(1800000).default(180000),
    delegationTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .default(300000),
    agents: z.array(agentSchema),
    bots: z.array(botSchema),
    projects: z.array(
      z
        .object({
          id,
          name: z.string().trim().min(1).max(80).optional(),
          root: z.string().trim().min(1),
        })
        .strict(),
    ),
    bindings: z.array(bindingSchema),
  })
  .strict()
  .transform((config) => {
    for (const bot of config.bots)
      bot.allowedUsers ??= [
        ...new Set(
          config.bindings
            .filter((b) => b.botId === bot.id)
            .flatMap((b) => b.allowedUsers),
        ),
      ];
    return config;
  });
export type Config = z.infer<typeof configSchema>;
export type Bot = Config["bots"][number];
export type Binding = Config["bindings"][number];
export function loadConfig(file: string): Config {
  return validateConfig(JSON.parse(readFileSync(file, "utf8")), file);
}
export function validateConfig(input: unknown, file: string): Config {
  const cfg = configSchema.parse(input);
  const base = path.dirname(path.resolve(file));
  cfg.stateDir = path.resolve(base, cfg.stateDir);
  for (const project of cfg.projects) {
    try {
      const expanded =
        project.root === "~"
          ? os.homedir()
          : project.root.startsWith("~/")
            ? path.join(os.homedir(), project.root.slice(2))
            : project.root;
      project.root = realpathSync(path.resolve(base, expanded));
    } catch {
      throw new Error("project_root_unavailable");
    }
    if (!statSync(project.root).isDirectory())
      throw new Error("project_root_not_directory");
  }
  for (const entries of [cfg.agents, cfg.bots, cfg.projects, cfg.bindings]) {
    if (new Set(entries.map((x) => x.id)).size !== entries.length)
      throw new Error("duplicate_config_id");
  }
  if (new Set(cfg.bots.map((b) => b.appId)).size !== cfg.bots.length)
    throw new Error("bots_must_use_distinct_apps");
  for (const bot of cfg.bots) {
    if (bot.projectId && !cfg.projects.some((p) => p.id === bot.projectId))
      throw new Error("invalid_binding");
    if (!cfg.agents.some((a) => a.id === bot.agentId))
      throw new Error("unknown_bot_agent");
    for (const peer of Object.keys(bot.peers))
      if (!cfg.agents.some((a) => a.id === peer) || peer === bot.agentId)
        throw new Error("invalid_peer");
  }
  const scopes = new Set();
  for (const b of cfg.bindings) {
    if (
      !cfg.bots.some((x) => x.id === b.botId) ||
      !cfg.projects.some((x) => x.id === b.projectId)
    )
      throw new Error("invalid_binding");
    const key = JSON.stringify([b.botId, b.chatId, b.threadId]);
    if (scopes.has(key)) throw new Error("ambiguous_binding");
    scopes.add(key);
    if (b.allowedAgents.some((a) => !cfg.agents.some((x) => x.id === a)))
      throw new Error("invalid_allowed_agent");
  }
  return cfg;
}

import { opendir, realpath, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const runFile = promisify(execFile);
export function expandHome(value: string) {
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

// Local operator endpoint only. Lists directory names, never reads file content.
export async function browseDirectories(input: {
  path?: string;
  hidden?: boolean;
}) {
  let root: string;
  try {
    root = await realpath(expandHome(input.path || os.homedir()));
    if (!(await stat(root)).isDirectory()) throw new Error("not_directory");
    const entries: { name: string; path: string }[] = [];
    let truncated = false;
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory() || (!input.hidden && entry.name.startsWith(".")))
        continue;
      if (entries.length === 500) {
        truncated = true;
        break;
      }
      entries.push({ name: entry.name, path: path.join(root, entry.name) });
    }
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
    return {
      path: root,
      parent: path.dirname(root),
      home: os.homedir(),
      entries,
      truncated,
    };
  } catch {
    throw new Error("directory_unavailable");
  }
}

type Agent = Config["agents"][number];
export type ModelOption = { value: string; label: string };
export type ModelCatalogResult = {
  models: ModelOption[];
  source: "codex_cache" | "pi_cli" | "grok_cli" | "unavailable";
  fetchedAt?: string;
};
const modelId = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/;
export function parseModelList(
  runtime: "pi" | "grok",
  output: string,
): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    let value: string | undefined;
    if (runtime === "pi" && parts.length >= 4 && /^\d/.test(parts[2])) {
      if (modelId.test(parts[0]) && modelId.test(parts[1]))
        value = `${parts[0]}/${parts[1]}`;
    }
    if (
      runtime === "grok" &&
      /^[*-]$/.test(parts[0]) &&
      modelId.test(parts[1] ?? "")
    )
      value = parts[1];
    if (value && modelId.test(value))
      models.set(value, { value, label: value });
  }
  return [...models.values()].slice(0, 500);
}
export function parseCodexModels(data: unknown): ModelOption[] {
  const models = (data as any)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m) =>
        m &&
        typeof m.slug === "string" &&
        modelId.test(m.slug) &&
        m.visibility === "list",
    )
    .slice(0, 500)
    .map((m) => ({
      value: m.slug,
      label:
        typeof m.display_name === "string"
          ? m.display_name.slice(0, 200)
          : m.slug,
    }));
}

export class ModelCatalog {
  private cache = new Map<
    string,
    { until: number; result: Promise<ModelCatalogResult> }
  >();
  constructor(
    private readonly readCatalog: (
      agent: Agent,
    ) => Promise<ModelCatalogResult> = readModelCatalog,
  ) {}
  get(agent: Agent) {
    const key = JSON.stringify([agent.runtime, agent.executable]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    // Coalesce concurrent dashboard requests; do not start repeated CLI processes.
    const result = this.readCatalog(agent).catch(() => ({
      models: [],
      source: "unavailable" as const,
    }));
    this.cache.set(key, { until: Date.now() + 60000, result });
    if (this.cache.size > 64)
      this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
async function readModelCatalog(agent: Agent): Promise<ModelCatalogResult> {
  if (agent.runtime === "codex") {
    const file = path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "models_cache.json",
    );
    if ((await stat(file)).size > 4 * 1024 * 1024)
      throw new Error("catalog_too_large");
    const data = JSON.parse(await readFile(file, "utf8"));
    const models = parseCodexModels(data);
    return {
      models,
      source: models.length ? "codex_cache" : "unavailable",
      fetchedAt:
        typeof data.fetched_at === "string"
          ? data.fetched_at.slice(0, 80)
          : undefined,
    };
  }
  const args =
    agent.runtime === "pi"
      ? [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--list-models",
        ]
      : ["models"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "GROK_HOME",
    "PI_CODING_AGENT_DIR",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const { stdout } = await runFile(agent.executable, args, {
    cwd: os.homedir(),
    env,
    timeout: 8000,
    maxBuffer: 512 * 1024,
    encoding: "utf8",
  });
  const models = parseModelList(agent.runtime, stdout);
  return {
    models,
    source: models.length
      ? agent.runtime === "pi"
        ? "pi_cli"
        : "grok_cli"
      : "unavailable",
  };
}

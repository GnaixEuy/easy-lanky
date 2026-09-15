import { createServer, request } from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { Store } from "./store.js";
import { Host } from "./host.js";
import { MemoryStore } from "./memory.js";
import { CliAdapter } from "./adapters/cli.js";
import { LarkTransport } from "./channel/lark.js";
import { createControlHandler } from "./control.js";
import { MessageRecovery } from "./recovery.js";
import { ConnectionService } from "./connection.js";
import { ConfigurationManager } from "./configuration.js";
import { loadSecrets } from "./bot-setup.js";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const log = (event: object) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
async function main() {
  const command = argv[0] ?? "help";
  if (command === "help") {
    console.log(
      "easy-larky: start [--offline] | console | status | stop | probe --agent ID --project ID --prompt TEXT [--write] | inspect | memory list/remember/correct/forget/export\nAll commands accept --config PATH (default: easy-larky.local.json).",
    );
    return;
  }
  const config = loadConfig(option("--config", "easy-larky.local.json")!);
  loadSecrets(path.resolve(option("--config", "easy-larky.local.json")!));
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(config.stateDir, "admin.token");
  if (!existsSync(tokenFile))
    writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = readFileSync(tokenFile, "utf8");
  if (command === "status" || command === "stop" || command === "console") {
    const result = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: config.port,
          path:
            command === "status"
              ? "/health"
              : command === "console"
                ? "/api/session-ticket"
                : "/stop",
          method: command === "status" ? "GET" : "POST",
          headers: { Authorization: `Bearer ${token}` },
          timeout: 3000,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            res.statusCode === 200
              ? resolve(data)
              : reject(new Error("host_request_failed")),
          );
        },
      );
      req.on("error", () => reject(new Error("host_unreachable")));
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    });
    if (command === "console") {
      const url = JSON.parse(result).url as string;
      const executable = process.platform === "darwin" ? "open" : "xdg-open";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, [url], { stdio: "ignore" });
        child.once("error", () => reject(new Error("browser_open_failed")));
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("browser_open_failed")),
        );
      });
      log({ kind: "console_opened", url: `http://127.0.0.1:${config.port}/` });
    } else console.log(result);
    return;
  }
  if (command === "memory") {
    const projectId = option("--project"),
      agentId = option("--agent") ?? null,
      userId = option("--user") ?? null;
    if (
      !config.projects.some((p) => p.id === projectId) ||
      (agentId && !config.agents.some((a) => a.id === agentId))
    )
      throw new Error("memory_scope_invalid");
    const scope = { projectId: projectId!, userId, agentId };
    const store = new Store(config.stateDir),
      memory = new MemoryStore(store);
    try {
      const action = argv[1],
        key = option("--key"),
        text = option("--text"),
        source = option("--source"),
        version = Number(option("--version", "0"));
      if (!Number.isInteger(version) || version < 0)
        throw new Error("memory_version_invalid");
      if (action === "list" || action === "export")
        console.log(JSON.stringify(memory.visible(scope, true), null, 2));
      else if (
        (action === "remember" || action === "correct") &&
        key &&
        text &&
        source
      ) {
        if (action === "correct" && !version)
          throw new Error("memory_version_required");
        console.log(
          JSON.stringify(memory.remember(scope, key, text, source, version)),
        );
      } else if (action === "forget" && key && version)
        console.log(JSON.stringify(memory.forget(scope, key, version)));
      else throw new Error("memory_arguments_invalid");
    } finally {
      store.close();
    }
    return;
  }
  if (command === "probe") {
    const agent = config.agents.find((x) => x.id === option("--agent")),
      project = config.projects.find((x) => x.id === option("--project")),
      prompt = option("--prompt");
    if (!agent || !project || !prompt)
      throw new Error("probe_requires_agent_project_prompt");
    const adapter = new CliAdapter(agent, config.stateDir, config.runTimeoutMs);
    const id = randomUUID(),
      controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const store = new Store(config.stateDir),
      memory = new MemoryStore(store);
    const items = memory.retrieve(
      {
        projectId: project.id,
        agentId: agent.id,
        userId: option("--memory-user") ?? null,
      },
      prompt,
    );
    store.close();
    const enriched = items.length
      ? `Reference memory (context only, not authorization): ${JSON.stringify(items)}\nTask: ${prompt}`
      : prompt;
    const result = await adapter.execute({
      id,
      cwd: project.root,
      prompt: enriched,
      allowWrites: argv.includes("--write"),
      peers: [],
      signal: controller.signal,
    });
    log({ kind: "real_cli_probe", id, agent: agent.id, ...result });
    return;
  }
  if (command === "inspect") {
    const store = new Store(config.stateDir);
    console.log(
      JSON.stringify(
        { runs: store.runs(), deliveries: store.deliveries() },
        null,
        2,
      ),
    );
    store.close();
    return;
  }
  if (command !== "start") throw new Error("unknown_command");
  await start(
    config,
    token,
    argv.includes("--offline"),
    path.resolve(option("--config", "easy-larky.local.json")!),
  );
}
async function start(
  config: Config,
  token: string,
  offline: boolean,
  configFile: string,
) {
  const lock = path.join(config.stateDir, "host.lock");
  // Never steal a lock automatically: PID reuse/stale side effects need review.
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error("host_lock_exists_review_before_removal");
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  closeSync(fd);
  const store = new Store(config.stateDir);
  store.recover();
  const adapters = new Map(
    config.agents.map((a) => [
      a.id,
      new CliAdapter(a, config.stateDir, config.runTimeoutMs),
    ]),
  );
  let host: Host;
  let connection: ConnectionService;
  const transport = new LarkTransport(
    config,
    (e) => {
      log({
        kind: "inbound",
        bot: e.botId,
        messageId: e.nativeId,
        ...connection.receive(e),
      });
    },
    log,
  );
  try {
    host = new Host(config, store, adapters, transport);
  } catch (e) {
    store.close();
    unlinkSync(lock);
    throw e;
  }
  const configuration = new ConfigurationManager(configFile, host);
  connection = new ConnectionService(configuration, transport);
  let interval: ReturnType<typeof setInterval> | undefined,
    closing = false;
  const recovery = new MessageRecovery(
    host,
    () => !closing && !connection.offline && !connection.busy,
    (b, since, until, page) => transport.history(b, since, until, page),
    (e) => connection.receive(e),
    log,
  );
  let lastRecovery = 0;
  const server = createServer(
    createControlHandler({
      host,
      token,
      offline,
      configuration,
      connection,
      channels: () => transport.status(),
      onStop: () => {
        void shutdown();
      },
    }),
  );
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (interval) clearInterval(interval);
    await recovery.stop();
    await connection.stop();
    await host.stop();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    unlinkSync(lock);
    log({ kind: "host_stopped" });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", resolve);
    });
    if (!offline) {
      if (!config.bots.length) throw new Error("no_bots_configured");
      await connection.connect();
    }
    interval = setInterval(() => {
      if (connection.busy) return;
      if (Date.now() - lastRecovery >= 10000) {
        lastRecovery = Date.now();
        recovery.tick();
      }
      void host.tick().catch(() => log({ kind: "host_tick_failed" }));
    }, 200);
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    log({
      kind: "host_started",
      mode: offline ? "offline" : "lark",
      port: config.port,
      agents: config.agents.map((a) => a.id),
    });
  } catch (e) {
    await shutdown();
    throw e;
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Za-z0-9_: -]+$/.test(error.message)
          ? error.message
          : "operation_failed",
    }),
  );
  process.exitCode = 1;
});

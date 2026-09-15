import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "../..");
const example = path.join(workspace, "env-config/host.example.json");
const destination = path.join(root, "easy-larky.local.json");
if (existsSync(destination))
  throw new Error("Local config already exists; refusing to overwrite.");
const config = JSON.parse(readFileSync(example, "utf8"));
config.stateDir = path.resolve(path.dirname(example), config.stateDir);
for (const project of config.projects) {
  project.root = path.resolve(path.dirname(example), project.root);
  mkdirSync(project.root, { recursive: true });
  const rules = path.join(project.root, "AGENTS.md");
  if (!existsSync(rules))
    writeFileSync(
      rules,
      "本目录仅用于 easy-larky 验收。只完成当前任务，不修改目录外文件，不发消息、不启动其他 Agent、不提交发布。遵守已有规则。\n",
    );
}
writeFileSync(destination, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
console.log("Created easy-larky.local.json (offline, no bot credentials).");

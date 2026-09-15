import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

// Reject traversal and symlinks, including dangling links in new write paths.
export function workspacePath(root: string, input: unknown): string {
  if (typeof input !== "string") throw new Error("workspace_path_required");
  root = realpathSync(root);
  const target = path.resolve(root, input);
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("workspace_path_denied");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("workspace_symlink_denied");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}

export function piToolsExtension(root: string, allowWrites: boolean): string {
  return `import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createReadTool, createLsTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
const workspacePath = ${workspacePath.toString()};
export default function(pi) {
  const root = ${JSON.stringify(root)};
  const factories = [createReadTool, createLsTool${allowWrites ? ", createEditTool, createWriteTool" : ""}];
  for (const factory of factories) {
    const tool = factory(root);
    pi.registerTool({ ...tool, name: "workspace_" + tool.name,
      async execute(id, params, signal, onUpdate) {
        const checked = workspacePath(root, params.path ?? ".");
        return tool.execute(id, { ...params, path: checked }, signal, onUpdate);
      }
    });
  }
}
`;
}

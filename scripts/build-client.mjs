import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";
const target = new URL("../dist/client/", import.meta.url);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
await build({
  entryPoints: ["src/client/app.tsx"],
  bundle: true,
  minify: true,
  outfile: "dist/client/client.js",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
cpSync(
  new URL("../src/client/index.html", import.meta.url),
  new URL("index.html", target),
);
cpSync(
  new URL("../node_modules/@douyinfe/semi-ui/LICENSE", import.meta.url),
  new URL("SemiDesign.LICENSE.txt", target),
);

// Real configured model; generated image input, no Feishu reads or sends.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { loadConfig } from "../dist/config.js";
import { CliAdapter } from "../dist/adapters/cli.js";
const config = loadConfig("easy-larky.local.json");
const bot = config.bots[0];
const agent = config.agents.find((a) => a.id === bot.agentId);
const output = path.resolve(
  "../../output/acceptance",
  `image-input-${randomUUID()}`,
);
mkdirSync(output, { recursive: true, mode: 0o700 });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(64, 0);
header.writeUInt32BE(64, 4);
header[8] = 8;
header[9] = 2;
const pixels = Buffer.alloc(64 * (64 * 3 + 1));
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
const image = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
const adapter = new CliAdapter(
  agent,
  path.join(output, "state"),
  config.runTimeoutMs,
);
const result = await adapter.execute({
  id: "image-proof",
  cwd: output,
  prompt: "请看随消息附带的图片，回答图片的主要颜色。不要调用工具。",
  images: [image],
  model: bot.model,
  allowWrites: false,
  peers: [],
  signal: AbortSignal.timeout(config.runTimeoutMs),
});
assert.match(result.decision.text, /红|red/i);
const proof = {
  runtime: agent.runtime,
  realModel: true,
  realImageInput: true,
  realFeishuImageDownload: false,
  realOutboundIM: false,
  text: result.decision.text,
};
writeFileSync(
  path.join(output, "proof.json"),
  JSON.stringify(proof, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify({ output, ...proof }));

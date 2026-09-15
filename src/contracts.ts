import { z } from "zod";
import { createHash } from "node:crypto";
const key = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    id: key,
    taskId: key,
    rootTaskId: key,
    from: key,
    to: key,
    projectId: key,
    kind: z.enum([
      "request",
      "accepted",
      "result",
      "failed",
      "cancel",
      "cancelled",
    ]),
    hop: z.number().int().min(1).max(3),
    text: z.string().max(12000),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export interface Inbound {
  userMentions?: Array<import("./contacts.js").Contact & { key: string }>;
  botId: string;
  nativeId: string;
  tenantKey: string;
  chatId: string;
  threadId: string | null;
  senderId: string;
  senderType: "human" | "agent" | "unknown";
  text: string;
  mentions: string[];
  mentionAll: boolean;
  chatType?: "p2p" | "group";
}
export interface Delivery {
  mode?: "reply" | "message" | "direct";
  direct?: { requestId: string; openId: string; name: string };
  runId?: string;
  id: string;
  botId: string;
  chatId: string;
  threadId: string | null;
  replyTo: string;
  mentionId?: string;
  text: string;
  envelope?: Envelope;
  status?: "accepted" | "result" | "failed" | "cancelled";
}
export interface Transport {
  runTool?(
    botId: string,
    request: import("./lark-tools.js").LarkToolRequest,
    context: import("./lark-tools.js").LarkToolContext,
  ): Promise<import("./lark-tools.js").LarkToolResult>;
  findContacts?(
    botId: string,
    query: string,
  ): Promise<import("./contacts.js").ContactResult>;
  send(message: Delivery): Promise<{ messageId: string }>;
}
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface Run {
  toolApproval?: string;
  mentionedContacts?: import("./contacts.js").Contact[];
  conversation?: { scope: string; epoch: string };
  id: string;
  rootTaskId: string;
  bindingId: string;
  agentId: string;
  origin: "human" | "agent";
  local?: { projectId: string; allowWrites: boolean };
  owner: string;
  nativeId: string;
  prompt: string;
  state: RunState;
  hop: number;
  delegations: number;
  phase: "execute" | "synthesize";
  request?: Envelope;
  child?: Envelope;
  waitingSince?: number;
  peerAccepted?: boolean;
  peerResult?: string;
  result?: string;
  error?: string;
  providerSession?: string;
  createdAt: number;
  updatedAt: number;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function parseEnvelope(text: string): Envelope | null {
  const start = text.indexOf("[easy-larky:v1]");
  if (start < 0) return null;
  return envelopeSchema.parse(
    JSON.parse(text.slice(start + "[easy-larky:v1]".length).trim()),
  );
}
export function wireText(d: Delivery): string {
  // Only registry-generated mentions may be active. Model output cannot inject mentions.
  const safe = d.text.replace(/</g, "＜").replace(/>/g, "＞");
  const mention = d.mentionId ? `<at user_id="${d.mentionId}"></at>\n` : "";
  return (
    mention +
    (d.envelope
      ? `[easy-larky:v1]\n${JSON.stringify(d.envelope).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}`
      : safe)
  );
}
export const decisionSchema = z
  .object({
    tool: z
      .object({ argv: z.array(z.string().max(16000)).min(1).max(60) })
      .strict()
      .nullable()
      .optional(),
    text: z.string().max(12000),
    sendTo: z
      .object({
        query: z.string().trim().min(1).max(100),
        text: z.string().trim().min(1).max(4000),
      })
      .strict()
      .nullable()
      .optional(),
    messages: z
      .array(z.string().trim().min(1).max(4000))
      .min(1)
      .max(5)
      .nullable()
      .optional(),
    delegate: z
      .object({ agent: key, prompt: z.string().min(1).max(8000) })
      .strict()
      .nullable(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;
export const decisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            argv: {
              type: "array",
              minItems: 1,
              maxItems: 60,
              items: { type: "string" },
            },
          },
          required: ["argv"],
        },
      ],
    },
    text: { type: "string" },
    sendTo: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" }, text: { type: "string" } },
          required: ["query", "text"],
        },
      ],
    },
    messages: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", minLength: 1, maxLength: 4000 },
        },
      ],
    },
    delegate: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: { agent: { type: "string" }, prompt: { type: "string" } },
          required: ["agent", "prompt"],
        },
      ],
    },
  },
  required: ["text", "delegate", "messages", "sendTo", "tool"],
};

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "../dist/client");

const mockConfig = {
  config: {
    version: 1,
    stateDir: "/tmp/easy-larky-preview",
    runTimeoutMs: 180000,
    agents: [
      { id: "chatgpt", runtime: "codex", executable: "codex", model: "gpt-4o" },
      { id: "grok", runtime: "grok", executable: "grok", model: "grok-2" },
      { id: "pi", runtime: "pi", executable: "pi", model: null },
    ],
    projects: [
      {
        id: "proj-1",
        name: "飞书插件核心项目",
        root: "/Users/gnaixeuy/Documents/ChatGPT/easy-larky",
      },
      {
        id: "proj-2",
        name: "AI 协作知识库",
        root: "/Users/gnaixeuy/Documents/Knowledge",
      },
    ],
    bots: [
      {
        id: "bot-feishu-1",
        name: "小羽助手 (ChatGPT)",
        agentId: "chatgpt",
        model: "gpt-4o",
        projectId: "proj-1",
        tenant: "feishu",
        appId: "cli_a1b2c3d4e5",
      },
      {
        id: "bot-feishu-2",
        name: "代码审计专家 (Grok)",
        agentId: "grok",
        model: "grok-2",
        projectId: "proj-1",
        tenant: "feishu",
        appId: "cli_f6g7h8i9j0",
      },
    ],
    bindings: [
      {
        id: "binding-1",
        botId: "bot-feishu-1",
        chatId: "oc_test_chat_001",
        threadId: null,
        projectId: "proj-1",
        allowedUsers: ["ou_user_yuxiang", "ou_user_yaguang"],
        allowSend: true,
        allowWrites: true,
      },
    ],
  },
  revision: "rev-preview-001",
  pendingRestart: false,
};

const mockState = {
  health: { mode: "lark", active: 0 },
  agents: mockConfig.config.agents,
  projects: mockConfig.config.projects,
  runs: [
    {
      id: "run-001",
      title: "分析飞书长连接漏收原因并提出方案",
      state: "completed",
      agentId: "chatgpt",
      source: "lark",
    },
    {
      id: "run-002",
      title: "检查工作区文件权限与 SQLite 存储",
      state: "running",
      agentId: "grok",
      source: "local",
    },
    {
      id: "run-003",
      title: "测试跨人员定向消息发送与确认码回执",
      state: "completed",
      agentId: "chatgpt",
      source: "lark",
    },
  ],
};

const mockConnection = {
  mode: "lark",
  busy: false,
  channels: [
    {
      botId: "bot-feishu-1",
      connection: "connected",
      lastRawAt: Date.now() - 15000,
    },
    {
      botId: "bot-feishu-2",
      connection: "connected",
      lastRawAt: Date.now() - 45000,
    },
  ],
  candidates: [
    {
      id: "cand-1",
      botId: "bot-feishu-1",
      senderId: "ou_user_new_guest",
      chatId: "oc_guest_chat_99",
      chatType: "p2p",
      preview: "你好，我想让小羽帮我查一下上周的需求文档",
    },
  ],
  lastInbound: {
    at: Date.now() - 15000,
    status: "accepted",
  },
};

const mockUsers = {
  users: [
    { botId: "bot-feishu-1", userId: "ou_user_yuxiang", name: "顾宇翔" },
    { botId: "bot-feishu-1", userId: "ou_user_yaguang", name: "贺亚光" },
  ],
};

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const url = new URL(req.url, "http://127.0.0.1:4390");
  const p = url.pathname;

  if (p === "/" || p === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(path.join(clientDir, "index.html")));
    return;
  }
  if (p === "/client.js") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(readFileSync(path.join(clientDir, "client.js")));
    return;
  }
  if (p === "/client.css") {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.end(readFileSync(path.join(clientDir, "client.css")));
    return;
  }

  res.setHeader("Content-Type", "application/json");
  if (p === "/api/session") {
    res.end(JSON.stringify({ token: "preview-token" }));
    return;
  }
  if (p === "/api/state") {
    res.end(JSON.stringify(mockState));
    return;
  }
  if (p === "/api/config") {
    res.end(JSON.stringify(mockConfig));
    return;
  }
  if (p === "/api/connection") {
    res.end(JSON.stringify(mockConnection));
    return;
  }
  if (p === "/api/access/users") {
    res.end(JSON.stringify(mockUsers));
    return;
  }
  if (p === "/api/registrations") {
    res.end(JSON.stringify([]));
    return;
  }
  if (p.startsWith("/api/runs/")) {
    res.end(
      JSON.stringify({
        run: {
          id: "run-001",
          state: "completed",
          prompt: "分析飞书长连接漏收原因并提出方案",
          local: false,
          result:
            "✅ 已完成分析：飞书 WebSocket 长连接在断网重连后需要通过 Inbound 去重游标补偿漏收事件，方案已归入 document/design/LARKIN_BASELINE_MIGRATION.md。",
          providerSessionId: "session-chatgpt-uuid-001",
        },
        deliveries: [
          {
            messageId: "om_receipt_001",
            at: Date.now() - 12000,
            state: "sent",
          },
        ],
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

const port = 4390;
server.listen(port, "127.0.0.1", () => {
  console.log(
    `PREVIEW_SERVER_READY:http://127.0.0.1:${port}/#ticket=preview-ticket`,
  );
});

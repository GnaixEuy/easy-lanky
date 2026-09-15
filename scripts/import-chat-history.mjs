// Explicit local operator action: import authorized private-chat text as context only.
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { loadSecrets, createLarkApi } from "../dist/bot-setup.js";
import { Store } from "../dist/store.js";
import {
  ConversationStore,
  importPrivateHistory,
} from "../dist/conversation.js";
const [file, bindingId, user] = process.argv.slice(2);
if (!file || !bindingId || !user)
  throw new Error(
    "usage: node scripts/import-chat-history.mjs CONFIG BINDING USER",
  );
const config = loadConfig(file);
if (existsSync(path.join(config.stateDir, "host.lock")))
  throw new Error("stop_host_before_history_import");
const binding = config.bindings.find(
  (b) =>
    b.id === bindingId &&
    b.threadId === null &&
    b.allowSend &&
    b.allowedUsers.includes(user),
);
if (!binding) throw new Error("authorized_private_binding_required");
const bot = config.bots.find((b) => b.id === binding.botId);
loadSecrets(file);
const api = await createLarkApi(
  bot.tenant,
  bot.appId,
  process.env[bot.appSecretEnv],
);
const chat = await api(
  `im/v1/chats/${encodeURIComponent(binding.chatId)}`,
  "history_chat_unavailable",
);
if (chat.data?.chat_mode !== "p2p") throw new Error("private_chat_required");
let page,
  items = [];
do {
  const query = new URLSearchParams({
    container_id_type: "chat",
    container_id: binding.chatId,
    sort_type: "ByCreateTimeAsc",
    page_size: "50",
    ...(page ? { page_token: page } : {}),
  });
  const response = await api(`im/v1/messages?${query}`, "history_unavailable");
  items.push(...(response.data?.items || []));
  if (items.length > 2000) throw new Error("history_import_limit_no_changes");
  if (response.data?.has_more && !response.data.page_token)
    throw new Error("history_pagination_invalid");
  const next = response.data?.has_more ? response.data.page_token : undefined;
  if (next && next === page) throw new Error("history_pagination_invalid");
  page = next;
} while (page);
const store = new Store(config.stateDir);
try {
  const history = new ConversationStore(store);
  const ref = history.current(config, binding, bot, user);
  const existing = history.context(ref);
  if (existing.totalPriorTurns || ref.epoch !== "initial")
    throw new Error("history_already_started_no_import");
  const count = importPrivateHistory(history, ref, binding, bot, user, items);
  store.audit(
    "conversation_imported",
    ref.scope,
    JSON.stringify({ count, source: "explicit_local_operator" }),
  );
  console.log(
    JSON.stringify({
      status: "imported_context_only",
      turns: count,
      runsCreated: 0,
    }),
  );
} finally {
  store.close();
}

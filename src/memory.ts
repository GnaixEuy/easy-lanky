import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
export const memoryScopeSchema = z
  .object({
    projectId: z.string().min(1),
    userId: z.string().nullable(),
    agentId: z.string().nullable(),
  })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export interface MemoryItem {
  id: string;
  key: string;
  scope: MemoryScope;
  text: string;
  source: string;
  status: "confirmed" | "candidate" | "forgotten";
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}
export class MemoryStore {
  constructor(readonly store: Store) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(scope,key));
      CREATE TABLE IF NOT EXISTS memory_revisions(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL);`);
  }
  private scope(scope: MemoryScope) {
    const s = memoryScopeSchema.parse(scope);
    return JSON.stringify([s.projectId, s.userId, s.agentId]);
  }
  private rows(): MemoryItem[] {
    return (
      this.store.db.prepare("SELECT data FROM memories").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  get(scope: MemoryScope, key: string): MemoryItem | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM memories WHERE scope=? AND key=?")
      .get(this.scope(scope), key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(item: MemoryItem, action: string) {
    this.store.db
      .prepare(
        "INSERT INTO memories VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data",
      )
      .run(
        item.id,
        this.scope(item.scope),
        item.key,
        item.version,
        JSON.stringify(item),
      );
    this.store.db
      .prepare(
        "INSERT INTO memory_revisions(id,version,action,at) VALUES (?,?,?,?)",
      )
      .run(item.id, item.version, action, Date.now());
  }
  remember(
    scope: MemoryScope,
    key: string,
    text: string,
    source: string,
    expectedVersion = 0,
    status: MemoryItem["status"] = "confirmed",
  ): MemoryItem {
    return this.store.transaction(() => {
      if (
        !/^[A-Za-z0-9_-]{1,80}$/.test(key) ||
        !text.trim() ||
        text.length > 4000 ||
        !source.trim() ||
        source.length > 500
      )
        throw new Error("invalid_memory");
      // Avoid accidental credential capture. This is a conservative guard, not a secret detector guarantee.
      if (
        /-----BEGIN .*PRIVATE KEY|(?:api[_-]?key|app[_-]?secret|access[_-]?token)\s*[:=]|\bsk-[A-Za-z0-9_-]{16,}/i.test(
          text,
        )
      )
        throw new Error("memory_secret_rejected");
      const old = this.get(scope, key);
      if ((old?.version ?? 0) !== expectedVersion)
        throw new Error("memory_version_conflict");
      if (old?.status === "forgotten")
        throw new Error("memory_forgotten_key_requires_new_key");
      const now = Date.now();
      const item: MemoryItem = {
        id: old?.id ?? randomUUID(),
        key,
        scope: memoryScopeSchema.parse(scope),
        text,
        source,
        status,
        version: expectedVersion + 1,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        expiresAt: null,
      };
      this.save(
        item,
        status === "candidate" ? "candidate" : old ? "correct" : "remember",
      );
      return item;
    });
  }
  forget(scope: MemoryScope, key: string, expectedVersion: number): MemoryItem {
    return this.store.transaction(() => {
      const item = this.get(scope, key);
      if (!item || item.version !== expectedVersion)
        throw new Error("memory_version_conflict");
      item.text = "";
      item.source = "";
      item.status = "forgotten";
      item.version++;
      item.updatedAt = Date.now();
      this.save(item, "forget");
      return item;
    });
  }
  visible(scope: MemoryScope, includeCandidates = false): MemoryItem[] {
    return this.rows().filter(
      (m) =>
        m.scope.projectId === scope.projectId &&
        (m.scope.userId === null || m.scope.userId === scope.userId) &&
        (m.scope.agentId === null || m.scope.agentId === scope.agentId) &&
        m.status !== "forgotten" &&
        (includeCandidates || m.status === "confirmed") &&
        (m.expiresAt === null || m.expiresAt > Date.now()),
    );
  }
  retrieve(scope: MemoryScope, query: string, budget = 6000): MemoryItem[] {
    const terms = query
      .toLowerCase()
      .split(/[\s,.;，。；]+/)
      .filter(Boolean);
    const score = (m: MemoryItem) =>
      terms.reduce((n, t) => n + (m.text.toLowerCase().includes(t) ? 1 : 0), 0);
    const sorted = this.visible(scope).sort(
      (a, b) =>
        score(b) - score(a) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
    let chars = 0;
    return sorted.filter((m) => {
      const cost = JSON.stringify(m).length;
      if (chars + cost > budget) return false;
      chars += cost;
      return true;
    });
  }
  snapshot(scope: MemoryScope) {
    const row = this.store.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) AS generation FROM memory_revisions",
      )
      .get() as { generation: number };
    return {
      generation: row.generation,
      scope,
      items: this.visible(scope, true),
    };
  }
  // Future consolidation publishes candidates only. Explicit user confirmation is required for retrieval.
  publishCandidates(
    scope: MemoryScope,
    generation: number,
    items: { key: string; text: string; source: string }[],
  ) {
    return this.store.transaction(() => {
      if (this.snapshot(scope).generation !== generation)
        throw new Error("memory_generation_conflict");
      if (items.length > 20) throw new Error("memory_candidate_limit");
      return items.map((item) =>
        this.remember(scope, item.key, item.text, item.source, 0, "candidate"),
      );
    });
  }
}

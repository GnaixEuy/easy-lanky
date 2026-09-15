import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import type { Run, Delivery } from "./contracts.js";
export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = path.join(directory, "state.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(scope TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,agent TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL,receipt TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,ref TEXT NOT NULL,detail TEXT NOT NULL);`);
    const version = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("schema") as { value: string } | undefined;
    if (version && version.value !== "1")
      throw new Error("unsupported_database_schema");
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
      .run("schema", "1");
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++,
      savepoint = `nested_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      try {
        const value = fn();
        this.db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
        return value;
      } catch (e) {
        this.db.exec(depth ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
        if (depth) this.db.exec(`RELEASE ${savepoint}`);
        throw e;
      }
    } finally {
      this.transactionDepth--;
    }
  }
  dedup(scope: string, id: string, hash: string): boolean {
    const old = this.db
      .prepare("SELECT hash FROM inbox WHERE scope=? AND id=?")
      .get(scope, id) as { hash: string } | undefined;
    if (old) {
      if (old.hash !== hash) throw new Error("message_id_conflict");
      return false;
    }
    this.db
      .prepare("INSERT INTO inbox VALUES (?,?,?,?,?)")
      .run(scope, id, hash, "received", Date.now());
    return true;
  }
  audit(kind: string, ref: string, detail: string) {
    this.db
      .prepare("INSERT INTO audit(at,kind,ref,detail) VALUES (?,?,?,?)")
      .run(Date.now(), kind, ref, detail);
  }
  save(run: Run) {
    run.updatedAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO runs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(run.id, run.state, run.agentId, JSON.stringify(run));
  }
  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  runs(): Run[] {
    return (
      this.db.prepare("SELECT data FROM runs ORDER BY rowid").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  enqueue(d: Delivery) {
    const old = this.db
      .prepare("SELECT data FROM outbox WHERE id=?")
      .get(d.id) as { data: string } | undefined;
    if (old) {
      if (old.data !== JSON.stringify(d))
        throw new Error("delivery_id_conflict");
      return;
    }
    this.db
      .prepare("INSERT INTO outbox VALUES (?,?,?,NULL,NULL)")
      .run(d.id, "pending", JSON.stringify(d));
  }
  deliveries(): {
    id: string;
    state: string;
    data: Delivery;
    receipt: string | null;
    error: string | null;
  }[] {
    return (
      this.db.prepare("SELECT * FROM outbox ORDER BY rowid").all() as any[]
    ).map((x) => ({ ...x, data: JSON.parse(x.data) }));
  }
  deliveryState(
    id: string,
    state: string,
    receipt: string | null = null,
    error: string | null = null,
  ) {
    this.db
      .prepare("UPDATE outbox SET state=?,receipt=?,error=? WHERE id=?")
      .run(state, receipt, error, id);
  }
  recover() {
    this.transaction(() => {
      for (const r of this.runs())
        if (r.state === "running") {
          r.state = "interrupted";
          r.error = "restart_requires_review";
          this.save(r);
          this.audit("interrupted", r.id, r.error);
        }
      this.db
        .prepare(
          "UPDATE outbox SET state='unknown',error='restart_during_send' WHERE state='sending'",
        )
        .run();
    });
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}

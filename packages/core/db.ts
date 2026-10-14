import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(
  path.join(config.dataDir, "autopilot.sqlite"),
);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,user_id TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS records_owner ON records(kind,user_id);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,run_after TEXT NOT NULL,locked_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,run_after);
CREATE TABLE IF NOT EXISTS receipts(application_id TEXT PRIMARY KEY,reference TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_events(key TEXT PRIMARY KEY,created_at TEXT NOT NULL);
`);
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function transaction<T>(work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function put<T extends object>(
  kind: string,
  recordId: string,
  userId: string,
  value: T,
): T & { id: string } {
  if (kind === "application") {
    const old = db
      .prepare("SELECT data FROM records WHERE kind='application' AND id=?")
      .get(recordId) as any;
    if (old) {
      const previous = JSON.parse(old.data);
      if (
        previous.status === "discarded" &&
        (value as any).status !== "discarded"
      )
        return previous;
    }
  }
  const t = now();
  const data = { ...value, id: recordId };
  db.prepare(
    "INSERT INTO records(kind,id,user_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
  ).run(kind, recordId, userId, JSON.stringify(data), t, t);
  return data;
}
export function get<T = any>(
  kind: string,
  recordId: string,
  userId?: string,
): T | undefined {
  const row = (
    userId === undefined
      ? db
          .prepare("SELECT data FROM records WHERE kind=? AND id=?")
          .get(kind, recordId)
      : db
          .prepare(
            "SELECT data FROM records WHERE kind=? AND id=? AND user_id=?",
          )
          .get(kind, recordId, userId)
  ) as any;
  return row ? JSON.parse(row.data) : undefined;
}
export function list<T = any>(kind: string, userId?: string): T[] {
  return (
    userId === undefined
      ? db
          .prepare(
            "SELECT data FROM records WHERE kind=? ORDER BY created_at DESC",
          )
          .all(kind)
      : db
          .prepare(
            "SELECT data FROM records WHERE kind=? AND user_id=? ORDER BY created_at DESC",
          )
          .all(kind, userId)
  ).map((r: any) => JSON.parse(r.data));
}
export function remove(kind: string, recordId: string, userId: string) {
  db.prepare("DELETE FROM records WHERE kind=? AND id=? AND user_id=?").run(
    kind,
    recordId,
    userId,
  );
}
export function audit(
  userId: string,
  actor: string,
  action: string,
  target: string,
  data: any = {},
) {
  return put("audit", id(), userId, { actor, action, target, data, at: now() });
}
export function event(
  userId: string,
  agent: string,
  message: string,
  details: any = {},
) {
  return put("event", id(), userId, { agent, message, details, at: now() });
}
export function enqueue(
  userId: string,
  kind: string,
  payload: any,
  delayMs = 0,
  mode = config.mode,
) {
  const jobId = id(),
    t = now();
  db.prepare(
    "INSERT INTO jobs(id,user_id,kind,payload,status,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    jobId,
    userId,
    kind,
    JSON.stringify({ ...payload, __mode: mode }),
    "pending",
    new Date(Date.now() + delayMs).toISOString(),
    t,
    t,
  );
  return jobId;
}
export function claimJob() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE status='pending' AND run_after<=? AND COALESCE(json_extract(payload,'$.__mode'),?)=? ORDER BY created_at LIMIT 1",
      )
      .get(now(), config.mode, config.mode) as any;
    if (job)
      db.prepare(
        "UPDATE jobs SET status='running',attempts=attempts+1,locked_at=?,updated_at=? WHERE id=?",
      ).run(now(), now(), job.id);
    db.exec("COMMIT");
    return job
      ? { ...job, attempts: job.attempts + 1, payload: JSON.parse(job.payload) }
      : null;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function finishJob(jobId: string, error?: string, retry = false) {
  db.prepare(
    "UPDATE jobs SET status=?,last_error=?,run_after=?,locked_at=NULL,updated_at=? WHERE id=?",
  ).run(
    error ? (retry ? "pending" : "failed") : "completed",
    error || null,
    new Date(Date.now() + 5000).toISOString(),
    now(),
    jobId,
  );
}
export function once(key: string) {
  return (
    db
      .prepare("INSERT OR IGNORE INTO seen_events(key,created_at) VALUES(?,?)")
      .run(key, now()).changes === 1
  );
}
export function recoverJobs() {
  const stale = db
    .prepare("SELECT * FROM jobs WHERE status='running'")
    .all() as any[];
  for (const j of stale) {
    if (["submit", "send_email"].includes(j.kind)) {
      finishJob(
        j.id,
        "Worker restarted during external action; reconcile outcome before retrying.",
      );
      const a = get(
        "application",
        JSON.parse(j.payload).applicationId,
        j.user_id,
      );
      if (a)
        put("application", a.id, j.user_id, {
          ...a,
          status: "submission_uncertain",
          error:
            "Worker restarted during submission. Check employer receipt before retrying.",
        });
    } else
      db.prepare(
        "UPDATE jobs SET status='pending',locked_at=NULL,updated_at=? WHERE id=?",
      ).run(now(), j.id);
  }
}

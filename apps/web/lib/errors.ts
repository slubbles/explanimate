/**
 * Recent errors, newest first. They land in the D1 `errors` table when the sign-in database is
 * configured, otherwise in an in-memory ring of the last 200. D1 rows older than 14 days are
 * pruned on write. Stored rows never carry emails in full, tokens, codes or cookies
 * (see the scrubbing in lib/log.ts). Reading and writing never throw: a D1 failure is logged
 * and the in-memory ring answers instead.
 */
import { d1Configured, ensureTables, getD1Db, type D1Db } from "./db";
import { scrubString } from "./log";

export type ErrorSource = "server" | "client";

export interface ErrorRow {
  id?: number;
  ts: number;
  route: string;
  source: ErrorSource;
  name: string;
  message: string;
  stack: string;
  requestId: string;
}

export const ERROR_MEMORY_CAP = 200;
export const ERROR_KEEP_MS = 14 * 24 * 3600_000;

/** Our tables exist before any error is stored (once per process; a failure retries on the next call). */
let ready: Promise<void> | undefined;
function ensureErrorTables(db: D1Db = getD1Db()): Promise<void> {
  ready ??= ensureTables(db).catch((e) => {
    ready = undefined;
    throw e;
  });
  return ready;
}

const memory: ErrorRow[] = [];

function remember(row: ErrorRow): void {
  memory.push(row);
  if (memory.length > ERROR_MEMORY_CAP) memory.splice(0, memory.length - ERROR_MEMORY_CAP);
}

/** Empty the in-memory ring (tests; the D1 table is untouched). */
export function clearMemoryErrors(): void {
  memory.length = 0;
}

/** One row from a route, a source and a caught value. Strings are scrubbed and trimmed. */
export function buildErrorRow(route: string, source: ErrorSource, error: unknown, requestId = "", nowMs = Date.now()): ErrorRow {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    ts: nowMs,
    route: String(route).slice(0, 120),
    source,
    name: e.name.slice(0, 80),
    message: scrubString(e.message).slice(0, 500),
    stack: scrubString(e.stack ?? "").slice(0, 2000),
    requestId: String(requestId).slice(0, 64),
  };
}

const pickDb = (db?: D1Db): D1Db | undefined => {
  if (db) return db;
  try {
    return d1Configured() ? getD1Db() : undefined;
  } catch {
    return undefined;
  }
};

/** Persist one error row: D1 when configured, else the in-memory ring. Never throws. */
export async function recordError(row: ErrorRow, db?: D1Db, nowMs = Date.now()): Promise<void> {
  const handle = pickDb(db);
  if (handle) {
    try {
      await ensureErrorTables(handle);
      await handle
        .prepare("INSERT INTO errors (ts, route, source, name, message, stack, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.ts, row.route, row.source, row.name, row.message, row.stack, row.requestId)
        .run();
      await handle
        .prepare("DELETE FROM errors WHERE ts < ?")
        .bind(nowMs - ERROR_KEEP_MS)
        .run()
        .catch(() => {});
      return;
    } catch (e) {
      console.error(`[errors] D1 store failed, keeping it in memory: ${(e as Error).message}`);
    }
  }
  remember(row);
}

const clampLimit = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(1, Math.floor(n))) : 50);

interface ErrorD1Row {
  id: number;
  ts: number;
  route: string;
  source: string;
  name: string;
  message: string;
  stack: string;
  requestId: string;
}

/** The newest error rows, newest first. Never throws (an empty list on failure). */
export async function listRecentErrors(limit = 50, db?: D1Db, nowMs = Date.now()): Promise<ErrorRow[]> {
  const n = clampLimit(limit);
  const handle = pickDb(db);
  if (handle) {
    try {
      await ensureErrorTables(handle);
      const rows = await handle
        .prepare("SELECT id, ts, route, source, name, message, stack, request_id AS requestId FROM errors ORDER BY id DESC LIMIT ?")
        .bind(n)
        .all<ErrorD1Row>();
      return rows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        route: String(r.route),
        source: r.source === "client" ? "client" : "server",
        name: String(r.name ?? ""),
        message: String(r.message ?? ""),
        stack: String(r.stack ?? ""),
        requestId: String(r.requestId ?? ""),
      }));
    } catch (e) {
      console.error(`[errors] D1 read failed, answering from memory: ${(e as Error).message}`);
    }
  }
  return memory
    .filter((r) => r.ts >= nowMs - ERROR_KEEP_MS)
    .slice(-n)
    .reverse();
}

/** How many errors happened since a timestamp (the health check passes "24 hours ago"). Never throws. */
export async function countErrorsSince(sinceMs: number, db?: D1Db): Promise<number> {
  const handle = pickDb(db);
  if (handle) {
    try {
      await ensureErrorTables(handle);
      const row = await handle.prepare("SELECT COUNT(*) AS n FROM errors WHERE ts >= ?").bind(sinceMs).first<{ n: number }>();
      return Number(row?.n) || 0;
    } catch (e) {
      console.error(`[errors] D1 count failed, answering from memory: ${(e as Error).message}`);
    }
  }
  return memory.filter((r) => r.ts >= sinceMs).length;
}

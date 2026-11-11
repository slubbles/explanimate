/**
 * The admin portal's gate and data. /admin and every /api/admin/* route answer 404 unless
 * sign-in is on AND the signed-in address is listed in EXPLANIMATE_ADMIN_EMAILS (or its short
 * alias ADMIN_EMAILS; a comma list, matched case-insensitively). Never 403: to anyone else the portal does not exist.
 * All D1 reads use bound parameters; nothing from the request is built into SQL.
 */
import fs from "node:fs";
import path from "node:path";
import { authEnabled, sessionUser, type SessionUser } from "./auth";
import { getD1Db, type D1Db } from "./db";
import { budget, caps, dailyBudget, dailyCap, dailyReserve, spent, spentToday } from "./guard";
import { fallbacksFromManifest, jobMetrics, jobTiming, type JobMetrics } from "./metrics";
import { defaultDailyVideos, ensureUsageTables, utcDay } from "./usage";

/** The admin addresses from the environment, lowercased. Empty when unset, which denies everyone. */
export function adminEmails(): string[] {
  return (process.env.EXPLANIMATE_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether an address is listed as an admin (case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().includes(email.trim().toLowerCase());
}

export type AdminGate = { ok: true; user: SessionUser } | { ok: false; response: Response };

/**
 * The gate every admin route and the /admin page check on the server. The session lookup is
 * injectable so tests can stand in for a signed-in user.
 */
export async function requireAdmin(req: Request, session: (req: Request) => Promise<SessionUser | null> = sessionUser): Promise<AdminGate> {
  const missing = () => Response.json({ error: "Not found." }, { status: 404 });
  if (!authEnabled()) return { ok: false, response: missing() };
  const user = await session(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) return { ok: false, response: missing() };
  return { ok: true, user };
}

/** A timestamp from Better Auth (ISO text or millis) as an ISO string, or "?" when unreadable. */
function asIso(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? v.slice(0, 32) : new Date(t).toISOString();
  }
  return "?";
}

export interface AdminUser {
  id: string;
  email: string;
  created: string;
  usedToday: number;
  limit: number;
}

/** Every account, newest first: address, when it signed up, today's usage and its daily limit. */
export async function listAdminUsers(nowMs = Date.now(), db: D1Db = getD1Db()): Promise<AdminUser[]> {
  await ensureUsageTables(db);
  const [users, limits, used] = await Promise.all([
    db
      .prepare("SELECT id, email, createdAt FROM user ORDER BY rowid DESC LIMIT 200")
      .bind()
      .all<{ id: string; email: string; createdAt: unknown }>(),
    db.prepare("SELECT user_id AS userId, daily_videos AS daily FROM user_limits").bind().all<{ userId: string; daily: number }>(),
    db.prepare("SELECT user_id AS userId, videos FROM usage WHERE day = ?").bind(utcDay(nowMs)).all<{ userId: string; videos: number }>(),
  ]);
  const limitById = new Map(limits.map((r) => [r.userId, Number(r.daily)]));
  const usedById = new Map(used.map((r) => [r.userId, Number(r.videos) || 0]));
  const dflt = defaultDailyVideos();
  return users.map((u) => {
    const n = limitById.get(u.id);
    return {
      id: u.id,
      email: u.email,
      created: asIso(u.createdAt),
      usedToday: usedById.get(u.id) ?? 0,
      limit: n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt,
    };
  });
}

export interface AdminVideo {
  id: string;
  input: string;
  inputLen: number;
  owner: string;
  created: string;
  status: string;
  cost: number;
  /** how long the job waited for an API slot, in ms (null when unknown or still waiting) */
  waitMs: number | null;
  /** how long the run waited for a render slot, in ms (null when unknown) */
  renderWaitMs: number | null;
  /** how long the render ran once it had a slot, in ms (null when unknown or unfinished) */
  renderMs: number | null;
  /** from the request until the job ended, in ms (null when unknown or unfinished) */
  totalMs: number | null;
}

export interface JobLike {
  id: string;
  state: string;
  costUsd?: number;
  usd?: { total?: number };
  started?: number;
  began?: number;
  finished?: number;
  accepted?: number;
  renderWaitMs?: number;
  stages?: Record<string, { start: number; end?: number }>;
}

/** The newest videos: owner from D1, live status and cost from the jobs on disk. */
export async function listAdminVideos(jobs: JobLike[], db: D1Db = getD1Db(), limit = 50): Promise<AdminVideo[]> {
  await ensureUsageTables(db);
  const rows = await db
    .prepare(
      "SELECT v.id AS id, v.user_id AS userId, v.input AS input, v.input_len AS inputLen, v.created_at AS createdAt," +
        " u.email AS email FROM videos v LEFT JOIN user u ON u.id = v.user_id ORDER BY v.created_at DESC LIMIT ?",
    )
    .bind(limit)
    .all<{ id: string; userId: string; input: string; inputLen: number; createdAt: number; email: string | null }>();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return rows.map((r) => {
    const full = String(r.input ?? "");
    const j = byId.get(r.id);
    const t =
      j?.started === undefined
        ? undefined
        : jobTiming({
            id: j.id,
            state: j.state,
            started: j.started,
            began: j.began,
            finished: j.finished,
            accepted: j.accepted,
            renderWaitMs: j.renderWaitMs,
            stages: j.stages,
          });
    return {
      id: r.id,
      input: full.slice(0, 120),
      inputLen: Number(r.inputLen) || full.length,
      owner: r.email ?? r.userId,
      created: asIso(Number(r.createdAt)),
      status: j?.state ?? "gone",
      cost: j?.costUsd ?? j?.usd?.total ?? 0,
      waitMs: t?.waitMs ?? null,
      renderWaitMs: t?.renderWaitMs ?? null,
      renderMs: t?.renderMs ?? null,
      totalMs: t?.totalMs ?? null,
    };
  });
}

export interface UsageDay {
  day: string;
  videos: number;
  users: number;
}

/** Videos started per UTC day, newest first. */
export async function usagePerDay(db: D1Db = getD1Db(), days = 30): Promise<UsageDay[]> {
  await ensureUsageTables(db);
  const rows = await db
    .prepare("SELECT day, SUM(videos) AS videos, COUNT(*) AS users FROM usage GROUP BY day ORDER BY day DESC LIMIT ?")
    .bind(days)
    .all<{ day: string; videos: number; users: number }>();
  return rows.map((r) => ({ day: r.day, videos: Number(r.videos) || 0, users: Number(r.users) || 0 }));
}

export interface SpendSummary {
  today: number;
  dailyCap: number;
  dailyOk: boolean;
  lifetime: { meta: number; voice: number };
  caps: { meta: number; voice: number };
  warnings: string[];
}

/** Today's spend under the daily cap, and lifetime spend under the service caps (guard.ts). */
export function spendSummary(
  all: { started?: number; usd?: { meta?: number; voice?: number } }[],
  dir: string,
  nowMs = Date.now(),
): SpendSummary {
  const lifetime = spent(dir, all);
  const b = budget(lifetime);
  const today = spentToday(dir, all, nowMs);
  const cap = dailyCap();
  return {
    today,
    dailyCap: cap,
    dailyOk: dailyBudget(today, cap, dailyReserve()).ok,
    lifetime,
    caps: caps(),
    warnings: b.warnings,
  };
}

const MAX_ADMIN_LIMIT = 1000;

export type LimitEdit = { ok: true; email: string; limit: number } | { ok: false; error: string };

/** A limit edit from the admin form: an account email and a whole number, 0 to 1000. */
export function parseLimitEdit(body: Record<string, unknown>): LimitEdit {
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { ok: false, error: "Enter the account's email address." };
  const limit = typeof body.limit === "number" ? body.limit : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ADMIN_LIMIT)
    return { ok: false, error: `The limit is a whole number of videos per day, 0 to ${MAX_ADMIN_LIMIT} (0 is the default).` };
  return { ok: true, email, limit };
}

/** A job as the live snapshot reads it (the jobs lib's Job fits this shape). */
export interface LiveSnapshotJob {
  id: string;
  kind?: string;
  state: string;
  stage?: string;
  message?: string;
  pct?: number;
  started: number;
  began?: number;
  finished?: number;
  durationSec?: number;
  costUsd?: number;
  usd?: { meta?: number; voice?: number; total?: number };
  error?: string;
  cancelled?: boolean;
  fallbacks?: { llm: boolean; tts: boolean };
  input?: string;
}

export interface LiveActiveJob {
  id: string;
  kind: string;
  state: string;
  stage: string;
  message: string;
  pct: number;
  started: number;
  /** place in the wait line (1-based) while still waiting, else null */
  queuePosition: number | null;
  cost: number;
}

/** The jobs running or waiting now, oldest first, each with its stage and place in line. */
export function selectActiveJobs(jobs: LiveSnapshotJob[], queue: string[]): LiveActiveJob[] {
  const place = new Map(queue.map((id, i) => [id, i + 1]));
  return jobs
    .filter((j) => j.state === "queued" || j.state === "running")
    .map((j) => ({
      id: j.id,
      kind: j.kind ?? "video",
      state: j.state,
      stage: j.stage ?? "start",
      message: j.message ?? "",
      pct: typeof j.pct === "number" ? j.pct : 0,
      started: j.started,
      queuePosition: j.state === "queued" ? (place.get(j.id) ?? null) : null,
      cost: j.costUsd ?? j.usd?.total ?? 0,
    }))
    .sort((a, b) => a.started - b.started);
}

export interface LiveFailure {
  id: string;
  kind: string;
  input: string;
  started: number;
  finished: number | null;
  error: string;
}

/** Failed runs, newest first, with their error text. Cancelled ones are left out: their owner stopped them. */
export function selectFailures(jobs: LiveSnapshotJob[], limit = 10): LiveFailure[] {
  return jobs
    .filter((j) => j.state === "error" && !j.cancelled)
    .sort((a, b) => b.started - a.started)
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      kind: j.kind ?? "video",
      input: (j.input ?? "").slice(0, 120),
      started: j.started,
      finished: typeof j.finished === "number" ? j.finished : null,
      error: (j.error ?? "stopped before the end").slice(0, 300),
    }));
}

export interface FallbackUsage {
  /** finished videos where the backup chat provider answered at least one call */
  llm: number;
  /** finished videos where the backup voice spoke at least one scene */
  tts: number;
  /** finished videos with an answer (anything unreadable is left out, never an error) */
  checked: number;
}

/** Parsed manifest fallbacks by job id (null when unreadable); manifests never change once written. */
export type ManifestCache = Map<string, { llm: boolean; tts: boolean } | null>;

/**
 * How many finished videos used each backup provider: recorded on the job when it finished,
 * else read once from its manifest.json and cached. Only 12-hex ids are read, so an odd id
 * can never escape the jobs folder.
 */
export function fallbackUsage(dir: string, jobs: LiveSnapshotJob[], cache: ManifestCache = new Map()): FallbackUsage {
  const use: FallbackUsage = { llm: 0, tts: 0, checked: 0 };
  for (const j of jobs) {
    if (j.state !== "done") continue;
    let flags = j.fallbacks;
    if (!flags) {
      if (!cache.has(j.id)) {
        let parsed: { llm: boolean; tts: boolean } | null = null;
        if (/^[a-f0-9]{12}$/.test(j.id)) {
          try {
            parsed = fallbacksFromManifest(JSON.parse(fs.readFileSync(path.join(dir, j.id, "manifest.json"), "utf8")));
          } catch {
            /* missing or torn manifest: left out */
          }
        }
        cache.set(j.id, parsed);
      }
      flags = cache.get(j.id) ?? undefined;
    }
    if (!flags) continue;
    use.checked++;
    if (flags.llm) use.llm++;
    if (flags.tts) use.tts++;
  }
  return use;
}

export interface AdminLive {
  now: number;
  /** the sign-in database (D1) is not answering, so signups and videos per day are empty (spend, jobs and fallbacks still work) */
  dbOff: boolean;
  active: LiveActiveJob[];
  queued: number;
  running: number;
  signups: { email: string; created: string }[];
  /** videos started per UTC day, newest first, last 14 days */
  videosPerDay: UsageDay[];
  failures: LiveFailure[];
  spend: SpendSummary;
  fallbacks: FallbackUsage;
  /** every job on this server, and the last 24 h (render p50 is medianRenderMs, p95 is p95RenderMs) */
  metrics: JobMetrics;
  metrics24h: JobMetrics;
}

export interface AdminLiveInput {
  jobs: LiveSnapshotJob[];
  queue: string[];
  jobsDir: string;
  db?: D1Db;
  cache?: ManifestCache;
  nowMs?: number;
}

const manifestCache: ManifestCache = new Map();

/**
 * Everything the dashboard refreshes, in one object: the page renders it on the server for the
 * first paint, then /api/admin/live serves it every few seconds. A database failure empties only
 * the account parts (dbOff says so); nothing here throws for a missing database.
 */
export async function getAdminLive(input: AdminLiveInput): Promise<AdminLive> {
  const { jobs, queue, jobsDir } = input;
  const nowMs = input.nowMs ?? Date.now();
  const cache = input.cache ?? manifestCache;
  let signups: AdminLive["signups"] = [];
  let videosPerDay: UsageDay[] = [];
  let dbOff = false;
  try {
    const db = input.db ?? getD1Db();
    const [users, days] = await Promise.all([listAdminUsers(nowMs, db), usagePerDay(db, 14)]);
    signups = users.slice(0, 10).map((u) => ({ email: u.email, created: u.created }));
    videosPerDay = days;
  } catch {
    dbOff = true;
  }
  return {
    now: nowMs,
    dbOff,
    active: selectActiveJobs(jobs, queue),
    queued: jobs.filter((j) => j.state === "queued").length,
    running: jobs.filter((j) => j.state === "running").length,
    signups,
    videosPerDay,
    failures: selectFailures(jobs),
    spend: spendSummary(jobs, jobsDir, nowMs),
    fallbacks: fallbackUsage(jobsDir, jobs, cache),
    metrics: jobMetrics(jobs),
    metrics24h: jobMetrics(jobs, nowMs - 24 * 3600_000),
  };
}

/** Set one account's daily override by email. The account signs in once first. */
export async function setUserLimit(
  email: string,
  n: number,
  db: D1Db = getD1Db(),
): Promise<{ ok: true; userId: string; limit: number } | { ok: false; error: string }> {
  await ensureUsageTables(db);
  const user =
    (await db.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>()) ??
    (email.toLowerCase() === email
      ? null
      : await db.prepare("SELECT id FROM user WHERE email = ?").bind(email.toLowerCase()).first<{ id: string }>());
  if (!user) return { ok: false, error: `No account for ${email} yet. They sign in once first, then try again.` };
  await db
    .prepare("INSERT INTO user_limits (user_id, daily_videos) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET daily_videos = ?")
    .bind(user.id, n, n)
    .run();
  return { ok: true, userId: user.id, limit: n };
}

/**
 * Videos per account per UTC day. The default comes from EXPLANIMATE_DAILY_VIDEOS
 * (default 3); a row in `user_limits` overrides it for one user. A video counts when
 * its job actually starts; follow-ups count too. The count is claimed with a single
 * atomic upsert, so two parallel requests cannot both slip past the limit.
 */
import { ensureTables, getD1Db, type D1Db } from "./db";

const DEFAULT_DAILY_VIDEOS = 3;

/** Our tables exist before any count is read (once per process; a failure retries on the next call). */
let ready: Promise<void> | undefined;
export function ensureUsageTables(db: D1Db = getD1Db()): Promise<void> {
  ready ??= ensureTables(db).catch((e) => {
    ready = undefined;
    throw e;
  });
  return ready;
}

/** Today as YYYY-MM-DD in UTC (pass `nowMs` in tests to cross midnight). */
export function utcDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function defaultDailyVideos(): number {
  const n = Number(process.env.EXPLANIMATE_DAILY_VIDEOS ?? DEFAULT_DAILY_VIDEOS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_VIDEOS;
}

/**
 * Whether an address skips the daily per-account cap (the admin list, case-insensitive).
 * Mirrors admin.ts without importing it (admin.ts imports usage.ts).
 */
function isUnlimitedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.EXPLANIMATE_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/** The limit for one user: null (unlimited) for admin addresses, else their override row, or the default. */
export async function dailyLimitFor(userId: string, db: D1Db = getD1Db(), email?: string | null): Promise<number | null> {
  if (isUnlimitedEmail(email)) return null;
  await ensureUsageTables(db);
  const row = await db.prepare("SELECT daily_videos AS n FROM user_limits WHERE user_id = ?").bind(userId).first<{ n: number }>();
  const n = Number(row?.n);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultDailyVideos();
}

/** One UTC day's video count for the usage page. */
export interface UsageDay {
  day: string;
  videos: number;
}

/** How many videos this user has started today (UTC). */
export async function videosUsedToday(userId: string, nowMs = Date.now(), db: D1Db = getD1Db()): Promise<number> {
  await ensureUsageTables(db);
  const row = await db
    .prepare("SELECT videos AS n FROM usage WHERE user_id = ? AND day = ?")
    .bind(userId, utcDay(nowMs))
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

export type Claim = { ok: true; used: number; limit: number | null } | { ok: false; error: string; status: 429 };

/**
 * Claim one of today's videos for a user, before the job starts. The upsert only counts
 * when the stored count is still under the limit, and it is one statement, so two parallel
 * claims cannot both pass: the loser sees no row back and gets the 429.
 * Admin addresses (see isUnlimitedEmail) still count up, but never refuse: limit is null.
 */
export async function claimVideoSlot(userId: string, nowMs = Date.now(), db: D1Db = getD1Db(), email?: string | null): Promise<Claim> {
  await ensureUsageTables(db);
  if (isUnlimitedEmail(email)) {
    const row = await db
      .prepare(
        "INSERT INTO usage (user_id, day, videos) VALUES (?, ?, 1) " +
          "ON CONFLICT (user_id, day) DO UPDATE SET videos = videos + 1 RETURNING videos",
      )
      .bind(userId, utcDay(nowMs))
      .first<{ videos: number }>();
    return { ok: true, used: Number(row?.videos) || 0, limit: null };
  }
  const limit = (await dailyLimitFor(userId, db, email)) ?? defaultDailyVideos();
  const row = await db
    .prepare(
      "INSERT INTO usage (user_id, day, videos) VALUES (?, ?, 1) " +
        "ON CONFLICT (user_id, day) DO UPDATE SET videos = videos + 1 WHERE videos < ? RETURNING videos",
    )
    .bind(userId, utcDay(nowMs), limit)
    .first<{ videos: number }>();
  if (!row) return { ok: false, status: 429, error: `You've used all ${limit} videos for today. Your limit resets at 00:00 UTC.` };
  return { ok: true, used: Number(row.videos) || 0, limit };
}

/** Give a claimed slot back (a follow-up that failed validation after its claim). Never below zero. */
export async function releaseVideoSlot(userId: string, nowMs = Date.now(), db: D1Db = getD1Db()): Promise<void> {
  await ensureUsageTables(db);
  await db.prepare("UPDATE usage SET videos = MAX(0, videos - 1) WHERE user_id = ? AND day = ?").bind(userId, utcDay(nowMs)).run();
}

/** Note which account started which job: owner, job id, prompt, prompt length, status and cost. Audit only: a failure is logged, never thrown. */
export async function recordVideo(jobId: string, userId: string, input: string, nowMs = Date.now(), db: D1Db = getD1Db()): Promise<void> {
  await ensureUsageTables(db).catch(() => {});
  const full = () =>
    db
      .prepare("INSERT INTO videos (id, user_id, input, created_at, input_len, status, cost) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(jobId, userId, input, nowMs, input.length, "started", 0)
      .run();
  await full()
    // databases from before the input_len/status/cost columns keep the old four-column row
    .catch(() =>
      db.prepare("INSERT INTO videos (id, user_id, input, created_at) VALUES (?, ?, ?, ?)").bind(jobId, userId, input, nowMs).run(),
    )
    .catch((e) => console.error(`[usage] could not record video ${jobId}: ${(e as Error).message}`));
}

/** This user's videos started per UTC day, newest first, for the usage page. */
export async function usageHistoryFor(userId: string, days = 30, db: D1Db = getD1Db()): Promise<UsageDay[]> {
  await ensureUsageTables(db);
  const rows = await db
    .prepare("SELECT day, videos FROM usage WHERE user_id = ? ORDER BY day DESC LIMIT ?")
    .bind(userId, days)
    .all<{ day: string; videos: number }>();
  return rows.map((r) => ({ day: r.day, videos: Number(r.videos) || 0 }));
}

/** Videos left today, for the "N of M left" line near the create button. Limit and left are null when unlimited. */
export async function videosLeftToday(
  userId: string,
  nowMs = Date.now(),
  db: D1Db = getD1Db(),
  email?: string | null,
): Promise<{ used: number; limit: number | null; left: number | null }> {
  const limit = await dailyLimitFor(userId, db, email);
  const used = await videosUsedToday(userId, nowMs, db);
  return { used, limit, left: limit === null ? null : Math.max(0, limit - used) };
}

export type LimitSet = { ok: true; userId: string; limit: number } | { ok: false; error: string };

/** Set one account's daily override by email (the admin script). The account signs in once first. */
export async function setUserLimitByEmail(email: string, n: number, db: D1Db = getD1Db()): Promise<LimitSet> {
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "The limit is a whole number of videos per day, at least 1." };
  await ensureUsageTables(db);
  const addr = email.trim();
  const user =
    (await db.prepare("SELECT id FROM user WHERE email = ?").bind(addr).first<{ id: string }>()) ??
    (addr.toLowerCase() === addr
      ? null
      : await db.prepare("SELECT id FROM user WHERE email = ?").bind(addr.toLowerCase()).first<{ id: string }>());
  if (!user) return { ok: false, error: `No account for ${addr} yet. They sign in once first, then try again.` };
  await db
    .prepare("INSERT INTO user_limits (user_id, daily_videos) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET daily_videos = ?")
    .bind(user.id, n, n)
    .run();
  return { ok: true, userId: user.id, limit: n };
}

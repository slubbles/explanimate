import fs from "node:fs";
import path from "node:path";

/**
 * Groundwork for a shared deployment: who is asking, how often, how big the request is, and whether the
 * Meta and Deepgram budgets still have room. Nothing here needs a key, and nothing here sends one anywhere.
 */

/**
 * The caller's address. X-Forwarded-For is only believed behind a proxy that sets it (EXPLANIMATE_TRUST_PROXY=1),
 * because anyone can send the header and dodge a per-IP limit with it.
 */
export function clientIp(req: Request): string {
  if (process.env.EXPLANIMATE_TRUST_PROXY !== "1") return "direct";
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

const hits = new Map<string, number[]>();
/** A sliding-window limit per key. Returns the seconds to wait when over, or 0. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return Math.ceil((recent[0] + windowMs - now) / 1000);
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return 0;
}

/** Per-IP request limit for the API routes that cost money or start work (EXPLANIMATE_REQ_PER_MIN, default 12). */
export function limitRequest(
  req: Request,
  route: string,
  perMin = Number(process.env.EXPLANIMATE_REQ_PER_MIN ?? 12),
): Response | undefined {
  const wait = rateLimit(`${route}:${clientIp(req)}`, perMin, 60_000);
  return wait
    ? Response.json({ error: `Too many requests. Try again in ${wait} s.` }, { status: 429, headers: { "retry-after": String(wait) } })
    : undefined;
}

/** Per-IP limit for job status reads (EXPLANIMATE_POLL_PER_MIN, default 240): the progress page polls once a second, and a few tabs share one IP. */
export const pollPerMin = () => Number(process.env.EXPLANIMATE_POLL_PER_MIN ?? 240);

const MAX_BODY_BYTES = 16 * 1024;
export const MAX_INPUT_CHARS = 2048;
const MAX_FIELD_CHARS = 300;

/** Read a JSON body of at most MAX_BODY_BYTES; anything larger or unparsable is refused with a plain message. */
export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  // a stated content type must be JSON (a cross-origin form cannot fake one); no header means an
  // empty body from a non-browser client, which reads as {} and fails the field checks instead
  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json"))
    return { error: Response.json({ error: "That request needs a JSON body." }, { status: 415 }) };
  const len = Number(req.headers.get("content-length") ?? 0);
  const tooBig = () => ({
    error: Response.json({ error: `That request is too large (over ${Math.round(max / 1024)} KB).` }, { status: 413 }),
  });
  if (len > max) return tooBig();
  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text) > max) return tooBig();
  if (!text.trim()) return { body: {} };
  try {
    const v = JSON.parse(text);
    return { body: v && typeof v === "object" && !Array.isArray(v) ? v : {} };
  } catch {
    return { error: Response.json({ error: "That request was not valid JSON." }, { status: 400 }) };
  }
}

/** A short text field, trimmed and cut to a length (undefined when missing or not a string). */
export const field = (v: unknown, max = MAX_FIELD_CHARS) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// ---- spend guard ----

export interface Spend {
  meta: number;
  voice: number;
}
export const caps = (): Spend => ({
  meta: Number(process.env.EXPLANIMATE_META_CAP_USD ?? 25),
  voice: Number(process.env.EXPLANIMATE_VOICE_CAP_USD ?? 10),
});
/** what one more video can cost, kept free under each cap so a job never starts that would cross it */
export const reserve = (): Spend => ({
  meta: Number(process.env.EXPLANIMATE_META_RESERVE_USD ?? 1),
  voice: Number(process.env.EXPLANIMATE_VOICE_RESERVE_USD ?? 0.15),
});
/** share of a cap at which a warning goes out */
const WARN_AT = 0.8;

const ledgerFile = (dir: string) => path.join(dir, "spend.jsonl");

/** Note money spent outside a video job (voice-mode chat, component explanations). */
export function recordSpend(dir: string, s: Partial<Spend>, what: string) {
  if (!s.meta && !s.voice) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerFile(dir), JSON.stringify({ t: Date.now(), what, meta: s.meta ?? 0, voice: s.voice ?? 0 }) + "\n");
}

/** Everything recorded so far: each job's live or final meter, plus the ledger of side calls. */
export function spent(dir: string, jobs: { usd?: { meta?: number; voice?: number } }[]): Spend {
  const s: Spend = { meta: 0, voice: 0 };
  for (const j of jobs) {
    s.meta += j.usd?.meta ?? 0;
    s.voice += j.usd?.voice ?? 0;
  }
  if (fs.existsSync(ledgerFile(dir))) {
    for (const line of fs.readFileSync(ledgerFile(dir), "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        s.meta += Number(e.meta) || 0;
        s.voice += Number(e.voice) || 0;
      } catch {
        /* blank or torn line */
      }
    }
  }
  return s;
}

export interface Budget {
  ok: boolean;
  error?: string;
  warnings: string[];
  spent: Spend;
  caps: Spend;
}

/** Whether there is room for another paid job, and a warning once either service passes 80% of its cap. */
export function budget(s: Spend, c = caps(), r = reserve()): Budget {
  const warnings: string[] = [];
  const name = { meta: "Meta (Muse)", voice: "Deepgram" } as const;
  let error: string | undefined;
  for (const k of ["meta", "voice"] as const) {
    if (s[k] + r[k] > c[k])
      error ??= `The ${name[k]} budget is nearly used up ($${s[k].toFixed(2)} of $${c[k].toFixed(2)}), so new videos are paused. Raise EXPLANIMATE_${k === "meta" ? "META" : "VOICE"}_CAP_USD to allow more.`;
    else if (s[k] >= c[k] * WARN_AT) warnings.push(`${name[k]} spend is at $${s[k].toFixed(2)} of a $${c[k].toFixed(2)} cap.`);
  }
  return { ok: !error, error, warnings, spent: s, caps: c };
}

// ---- global daily spend guard (works whether sign-in is on or off) ----

const DEFAULT_DAILY_CAP_USD = 3;
const DAILY_BUDGET_ERROR = "Today's budget is used up, new videos are paused until 00:00 UTC.";

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The combined Meta + voice cap for one UTC day (EXPLANIMATE_DAILY_CAP_USD, default 3). */
export function dailyCap(): number {
  const n = Number(process.env.EXPLANIMATE_DAILY_CAP_USD ?? DEFAULT_DAILY_CAP_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP_USD;
}

/** What one more video can cost, kept free under the daily cap (both reserves together). */
export function dailyReserve(): number {
  const r = reserve();
  return r.meta + r.voice;
}

/** Today's (UTC) Meta + voice spend: job meters started today plus today's ledger lines. */
export function spentToday(dir: string, jobs: { started?: number; usd?: { meta?: number; voice?: number } }[], nowMs = Date.now()): number {
  const day = utcDay(nowMs);
  let total = 0;
  for (const j of jobs) {
    if (j.started && utcDay(j.started) === day) total += (j.usd?.meta ?? 0) + (j.usd?.voice ?? 0);
  }
  if (fs.existsSync(ledgerFile(dir))) {
    for (const line of fs.readFileSync(ledgerFile(dir), "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.t && utcDay(Number(e.t)) === day) total += (Number(e.meta) || 0) + (Number(e.voice) || 0);
      } catch {
        /* blank or torn line */
      }
    }
  }
  return total;
}

/** Whether today's spend leaves room for another video under the daily cap. */
export function dailyBudget(todaySpend: number, cap = dailyCap(), res = dailyReserve()): { ok: boolean; error?: string } {
  return todaySpend + res > cap ? { ok: false, error: DAILY_BUDGET_ERROR } : { ok: true };
}

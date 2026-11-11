/**
 * Who a job belongs to. A signed-in viewer owns jobs as their account ("u:<id>"); everyone else
 * owns them through a random, HttpOnly browser cookie that only the server sees, stored as its
 * SHA-256 ("a:<hash>"), so a leaked job file never holds a usable cookie value. The owner key
 * scopes the jobs list and decides who may cancel a run.
 */
import crypto from "node:crypto";
import { authEnabled, sessionUser } from "./auth";

const OWNER_COOKIE = "ex_owner";
const TOKEN = /^[a-f0-9]{32}$/;
const MAX_AGE_S = 60 * 60 * 24 * 30;

/** The owner cookie's value on this request, if it is well formed. */
export function ownerToken(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === OWNER_COOKIE) {
      const t = v.join("=");
      return TOKEN.test(t) ? t : undefined;
    }
  }
  return undefined;
}

export const anonKey = (token: string) => `a:${crypto.createHash("sha256").update(token).digest("hex")}`;

/** The viewer's owner key (account first, then the browser cookie), or undefined for a stranger. */
export async function viewerKey(req: Request): Promise<string | undefined> {
  if (authEnabled()) {
    const u = await sessionUser(req);
    if (u) return `u:${u.id}`;
  }
  const t = ownerToken(req);
  return t ? anonKey(t) : undefined;
}

/**
 * The owner key for a job this request is about to create, plus the Set-Cookie header to send
 * when the browser has no owner cookie yet.
 */
export async function claimOwner(req: Request, userId?: string): Promise<{ key: string; setCookie?: string }> {
  if (userId) return { key: `u:${userId}` };
  const have = ownerToken(req);
  if (have) return { key: anonKey(have) };
  const t = crypto.randomBytes(16).toString("hex");
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const cookie = `${OWNER_COOKIE}=${t}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return { key: anonKey(t), setCookie: cookie };
}

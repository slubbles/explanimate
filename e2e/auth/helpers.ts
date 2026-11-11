import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";

/** Cloudflare's documented dummy token, accepted with the test secret (see lib/turnstile.ts). */
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export const tmpRoot = (port: number) => path.join(os.tmpdir(), `explanimate-e2e-${port}`);
export const mailDir = (port: number) => path.join(tmpRoot(port), "mail");
export const jobsDir = (port: number) => path.join(tmpRoot(port), "jobs");

let counter = 0;
/** A fresh address per test, so daily counts and per-address limits never leak between tests. */
export const uniqueEmail = () => `e2e-${Date.now()}-${process.pid}-${counter++}@example.com`;

/** A fresh caller address per test (the server trusts X-Forwarded-For in these runs). */
export const uniqueIp = () => `10.${counter % 256}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

const portOf = (baseURL: string) => Number(new URL(baseURL).port);

/** Ask for a login code for an address. */
export async function requestCode(req: APIRequestContext, baseURL: string, email: string, ip: string) {
  return req.post("/api/auth/email-otp/send-verification-otp", {
    data: { email, type: "sign-in" },
    headers: { origin: baseURL, "x-turnstile-token": DUMMY_TOKEN, "x-forwarded-for": ip },
  });
}

/** The captured 6-digit code for an address, waiting briefly for the file to land. */
export async function readOtp(baseURL: string, email: string): Promise<string> {
  const file = path.join(mailDir(portOf(baseURL)), `${email}.json`);
  for (let i = 0; i < 50; i++) {
    try {
      const row = JSON.parse(fs.readFileSync(file, "utf8")) as { otp?: string };
      if (row.otp) return row.otp;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no captured code for ${email} in ${file}`);
}

/** Check a code; on success the request context holds the session cookie. */
export async function verifyCode(req: APIRequestContext, baseURL: string, email: string, otp: string, ip: string) {
  return req.post("/api/auth/sign-in/email-otp", {
    data: { email, otp },
    headers: { origin: baseURL, "x-forwarded-for": ip },
  });
}

/** Request a code and sign in with it; returns the signed-in address. */
export async function signIn(req: APIRequestContext, baseURL: string, email: string, ip: string): Promise<string> {
  const sent = await requestCode(req, baseURL, email, ip);
  if (!sent.ok()) throw new Error(`send-verification-otp failed: ${sent.status()} ${await sent.text()}`);
  const otp = await readOtp(baseURL, email);
  const verified = await verifyCode(req, baseURL, email, otp, ip);
  if (!verified.ok()) throw new Error(`sign-in failed: ${verified.status()} ${await verified.text()}`);
  return email;
}

/** Start a video as this caller (signed in or not). */
export async function createVideo(req: APIRequestContext, baseURL: string, input: string, ip: string) {
  return req.post("/api/jobs", {
    data: { input, voice: "silent" },
    headers: { origin: baseURL, "x-forwarded-for": ip },
  });
}

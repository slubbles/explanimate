import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { llmProvider, llmFallback, type LlmProvider } from "@explanimate/core/llm";

/** What a load balancer or uptime check needs to know. Keys are reported present or missing, never their values. */
export interface Health {
  ok: boolean;
  checks: { ffmpeg: boolean; chrome: boolean; modelKey: boolean; voiceKey: boolean; jobsDir: boolean };
  /** new videos are refused: demo-only mode or the spend cap */
  paused: boolean;
  problems: string[];
  /** whether a backup AI service would take over if the primary fails (booleans only, never key values) */
  fallbacks: { llm: boolean; tts: boolean };
}

const CHROME = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Chrome's usual Windows install folders, so a fresh machine is healthy without EXPLANIMATE_CHROME. */
function windowsChrome(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [];
  const programFiles = env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

export interface Probe {
  env: NodeJS.ProcessEnv;
  has: (file: string) => boolean;
  runs: (cmd: string) => boolean;
  writable: (dir: string) => boolean;
}

const realProbe: Probe = {
  env: process.env,
  has: (f) => fs.existsSync(/*turbopackIgnore: true*/ f),
  runs: (cmd) => spawnSync(cmd, ["-version"], { stdio: "ignore", timeout: 5000 }).status === 0,
  writable: (dir) => {
    try {
      fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
      const f = path.join(dir, ".health");
      fs.writeFileSync(/*turbopackIgnore: true*/ f, String(Date.now()));
      fs.rmSync(/*turbopackIgnore: true*/ f);
      return true;
    } catch {
      return false;
    }
  },
};

/** Healthy means a video can be made: ffmpeg, Chrome, the key for the Muse Spark provider (OpenRouter or Meta) and a writable jobs folder. Voice is optional. */
export function checkHealth(jobsDir: string, budgetOk: boolean, p: Probe = realProbe): Health {
  let llm: LlmProvider | undefined,
    badProvider = "",
    llmBackup = false;
  try {
    llm = llmProvider(p.env);
    llmBackup = llmFallback(p.env) !== undefined;
  } catch (e) {
    badProvider = (e as Error).message;
  }
  const checks = {
    ffmpeg: p.runs("ffmpeg"),
    chrome: [p.env.EXPLANIMATE_CHROME, ...CHROME, ...windowsChrome(p.env)].some((f) => !!f && p.has(f)),
    modelKey: !!llm && !!p.env[llm.keyVar],
    voiceKey: !!p.env.DEEPGRAM_API_KEY,
    jobsDir: p.writable(jobsDir),
  };
  const problems: string[] = [];
  if (!checks.ffmpeg) problems.push("ffmpeg is not on the PATH.");
  if (!checks.chrome) problems.push("Chrome or Chromium was not found. Set EXPLANIMATE_CHROME.");
  if (!checks.modelKey) problems.push(badProvider || `${llm!.keyVar} is not set.`);
  if (!checks.jobsDir) problems.push("The jobs folder is not writable. Check EXPLANIMATE_JOBS_DIR and the volume.");
  const paused = p.env.EXPLANIMATE_DEMO_ONLY === "1" || !budgetOk;
  return { ok: problems.length === 0, checks, paused, problems, fallbacks: { llm: llmBackup, tts: !!p.env.CARTESIA_API_KEY } };
}

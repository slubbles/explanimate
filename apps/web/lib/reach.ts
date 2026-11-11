import { execFile } from "node:child_process";

/** Edit distance between two names, ignoring case and dashes (speech blurs both). */
function distance(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[-_.\s]/g, ""),
    y = b.toLowerCase().replace(/[-_.\s]/g, "");
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/** The closest names to what was heard, best first, only ones near enough to be a mishearing. */
export function closest(heard: string, names: string[], n = 3): string[] {
  return names
    .map((name) => ({ name, d: distance(heard, name) }))
    .filter((c) => c.d <= Math.max(2, Math.ceil(heard.length * 0.4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((c) => c.name);
}

const lsRemote = (url: string) =>
  new Promise<boolean>((ok) => {
    execFile(
      "git",
      ["ls-remote", "--exit-code", `${url}.git`, "HEAD"],
      { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (e) => ok(!e),
    );
  });

/**
 * A spoken repo name is often misheard, so a GitHub link is checked before the job starts (with the same access the
 * clone uses). If it is not there, the error names the owner's closest repos for the assistant to offer back.
 */
export async function checkRepo(url: string): Promise<string | undefined> {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m || (await lsRemote(url))) return undefined;
  const [, owner, repo] = m;
  let near: string[] = [];
  try {
    const r = await fetch(`https://api.github.com/users/${owner}/repos?per_page=100&sort=pushed`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok)
      near = closest(
        repo,
        ((await r.json()) as { name: string }[]).map((x) => x.name),
      );
  } catch {
    /* no suggestions then */
  }
  return near.length
    ? `github.com/${owner}/${repo} was not found. Repos by ${owner} that sound close: ${near.map((n) => `github.com/${owner}/${n}`).join(", ")}. Ask in one short question whether they meant the first one (say it naturally, not letter by letter); if yes, call start_video with that link.`
    : `github.com/${owner}/${repo} was not found. Say the owner and repo name you heard and ask them to correct it or type the link.`;
}

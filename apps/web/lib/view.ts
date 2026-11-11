/**
 * What the jobs API shows. A single job is readable by anyone holding its 12-hex id (that is the
 * share link), but never with its server-side fields: CLI arguments, folder paths and the owner
 * key stay on the server. Lists are narrower still: only the viewer's own jobs, or the follow-up
 * clips of a video whose id the viewer already holds.
 */
import { NO_STORE_VALUE } from "./cache";
import { jobTiming } from "./metrics";
import { asSeen } from "./steps";
import type { Job } from "./jobs";

/** Fields that exist only for the server (resume arguments, owner, slot bookkeeping). */
const SERVER_ONLY = ["args", "owner", "resumed", "began", "finished", "deleted"] as const;

/** Server paths never reach the browser: an absolute path in an error reads as told, without the path. */
export function scrubError(e: string): string {
  return e
    .replace(/[a-zA-Z]:\\(?:[^\\/:*?"<>|\s]+\\)*[^\\/:*?"<>|\s]*/g, "(a server path)")
    .replace(/(?<![\w/])(?:\/[\w.-]+){2,}\/?/g, "(a server path)")
    .replace(/\s+/g, " ")
    .trim();
}

/** One job as a viewer sees it, with `mine` telling the page whether it may offer Cancel. */
export function publicJob(job: Job, viewer?: string) {
  const seen: Record<string, unknown> = { ...asSeen(job) };
  for (const k of SERVER_ONLY) delete seen[k];
  if (typeof seen.error === "string") seen.error = scrubError(seen.error);
  const timings = jobTiming(job);
  timings.error = scrubError(timings.error);
  seen.timings = timings;
  return { ...seen, mine: !!viewer && job.owner === viewer };
}

/** A follow-up clip as the parent's result page lists it: no input, cost or file names. */
const clipRow = (j: Job) => {
  const s = asSeen(j);
  return { id: s.id, kind: s.kind, parent: s.parent, focus: s.focus, whatIf: s.whatIf, state: s.state, title: s.title, started: s.started };
};

/** One of the viewer's own jobs in their list. */
const ownRow = (j: Job) => {
  const s = asSeen(j);
  return {
    ...clipRow(j),
    input: s.input,
    approach: s.approach,
    voice: s.voice,
    costUsd: s.costUsd,
    durationSec: s.durationSec,
    mp4: s.outputs?.mp4,
  };
};

/** The jobs list for this request: clips of a known parent, else the viewer's own, else nothing. */
export function listFor(all: Job[], viewer: string | undefined, parent: string | null) {
  if (parent)
    return /^[a-f0-9]{12}$/.test(parent)
      ? all
          .filter((j) => j.parent === parent)
          .slice(0, 40)
          .map(clipRow)
      : [];
  if (!viewer) return [];
  return all
    .filter((j) => j.owner === viewer)
    .slice(0, 40)
    .map(ownRow);
}

export const NO_STORE = { "cache-control": NO_STORE_VALUE };

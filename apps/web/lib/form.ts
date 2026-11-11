/** The choices on the input form. */
export type Form = { input: string; voice: string; format: FormatId };

export const VOICES = [
  { id: "deepgram", label: "Narrated" },
  { id: "silent", label: "Captions only" },
] as const;

/** The explanation formats the picker offers; auto lets the engine decide. */
export type FormatId = "auto" | "short" | "deep" | "anatomy";
export const FORMATS: { id: FormatId; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "short", label: "Short" },
  { id: "deep", label: "Deep" },
  { id: "anatomy", label: "Anatomy" },
];
export const DEFAULT_FORM: Form = { input: "", voice: "deepgram", format: "auto" };

/** The format for the job request: left out when Auto, so the engine decides. */
export function formatForRequest(f: FormatId): { format?: Exclude<FormatId, "auto"> } {
  return f === "auto" ? {} : { format: f };
}

/** The form a saved job was made with, so reopening it shows its own link, voice and format instead of the defaults. */
export function formFromJob(job: { input?: unknown; voice?: unknown; ask?: unknown }): Form {
  const voice = VOICES.some((v) => v.id === job.voice) ? String(job.voice) : DEFAULT_FORM.voice;
  const asked = (job.ask as { format?: unknown } | undefined)?.format;
  const format: FormatId = asked === "short" || asked === "deep" || asked === "anatomy" ? asked : "auto";
  return { input: typeof job.input === "string" ? job.input : "", voice, format };
}

/** What kind of source a link is, in the words the gallery uses. */
export function sourceKind(input: string): "repo" | "X post" | "article" | "topic" {
  if (!/^https?:\/\//i.test(input) && !input.startsWith("/")) return "topic";
  if (/^https?:\/\/(www\.)?github\.com\//i.test(input) || input.startsWith("/")) return "repo";
  if (/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(input)) return "X post";
  return "article";
}

/** A link as people read it: no scheme, no trailing slash. */
export const shortLink = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

/** Topics in words are capped here (lib/validate.ts); links may run to MAX_INPUT_CHARS. */
export const TOPIC_MAX = 300;
export const LINK_MAX = 2048;

// bare domains people type without a path; ".js" and the like stay topics ("next.js")
const BARE_TLDS = /\.(com|org|net|io|dev|ai|co|app|blog|so|sh|me|xyz|news|info|edu|gov)$/i;

/** Add the https:// people leave off ("github.com/a/b", "x.com/u/status/1", "www.site.com"), so a pasted link is not refused as a topic. */
export function normalizeInput(raw: string): string {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\s/.test(s)) return s;
  const host = s.split(/[/?#]/)[0];
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?$/i.test(host)) return s;
  const withPath = s.length > host.length && s[host.length] === "/" && s.length > host.length + 1;
  if (withPath || /^www\./i.test(host) || BARE_TLDS.test(host)) return `https://${s}`;
  return s;
}

/** The hint under the field: a counter once a topic nears its cap, and a plain reason when it is over. */
export function inputHint(raw: string): { count?: string; over?: string } {
  const s = normalizeInput(raw);
  if (/^https?:\/\//i.test(s))
    return s.length > LINK_MAX ? { over: "That link is too long. Paste just the repo, post or article URL." } : {};
  if (s.length < TOPIC_MAX - 60) return {};
  const count = `${s.length} / ${TOPIC_MAX}`;
  return s.length > TOPIC_MAX
    ? { count, over: `Topics are ${TOPIC_MAX} characters at most. Name it in a few words, or paste a link.` }
    : { count };
}

/** Why a finished video has no boxes to tap: only repo videos map each box to real files. */
export function noBoxesNote(input: string): string {
  const kind = sourceKind(input);
  if (kind === "repo") return "This video has no box map, so there is nothing to tap. Tap-to-ask and what-if clips need one.";
  const what = kind === "topic" ? "a topic" : kind === "X post" ? "an X post" : "an article";
  return `Tap-to-ask and what-if clips work on GitHub repo videos, where every box maps to real files. This one explains ${what}, so it has no boxes to tap.`;
}

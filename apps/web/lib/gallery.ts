import fs from "node:fs";
import path from "node:path";
import { captionsToVtt } from "./captions";

/**
 * The example videos shown on the home page and at /gallery. They are a hand-picked folder of finished videos
 * (EXPLANIMATE_GALLERY_DIR) with a gallery.json beside them, never the jobs visitors made. No folder, no
 * gallery.json or no playable entry means no gallery, and the page hides the section.
 */

export type GalleryKind = "repo" | "X post" | "article" | "topic";
export interface GalleryVideo {
  id: string;
  title: string;
  kind: GalleryKind;
  source?: string;
  durationSec?: number;
  file: string;
  poster?: string;
  /** captions data in the folder: a ready .vtt, or a .json with film-style timed words to turn into one */
  captions?: string;
  /**
   * Whether the captions are already drawn into the video. Explanimate renders always draw them, so this is
   * true unless the manifest says `"burnedCaptions": false`; a video with drawn-in captions gets no track.
   */
  burnedCaptions: boolean;
}
/** What the page gets: the entry plus the URLs to play it from. */
export type GalleryItem = Omit<GalleryVideo, "file" | "poster" | "captions" | "burnedCaptions"> & {
  src: string;
  poster?: string;
  captions?: string;
};

const KINDS: GalleryKind[] = ["repo", "X post", "article", "topic"];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIDEO = /^[\w-][\w.-]{0,120}\.mp4$/;
const IMAGE = /^[\w-][\w.-]{0,120}\.(jpg|jpeg|png|webp)$/;
const CAPTIONS = /^[\w-][\w.-]{0,120}\.(vtt|json)$/;
export const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const galleryDir = () => process.env.EXPLANIMATE_GALLERY_DIR?.trim() || undefined;

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const inside = (dir: string, name: string) => {
  const f = path.resolve(dir, name);
  return path.dirname(f) === path.resolve(dir) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : undefined;
};

/** The manifest's entries whose video is really in the folder, in manifest order. Bad entries are skipped. */
export function loadGallery(dir = galleryDir()): GalleryVideo[] {
  if (!dir) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "gallery.json"), "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { videos?: unknown })?.videos;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: GalleryVideo[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const id = str(e?.id),
      title = str(e?.title, 120),
      file = str(e?.file);
    if (!id || !ID.test(id) || seen.has(id) || !title || !file || !VIDEO.test(file) || !inside(dir, file)) continue;
    const poster = str(e.poster);
    const captions = str(e.captions);
    const kind = KINDS.includes(e.kind as GalleryKind) ? (e.kind as GalleryKind) : "topic";
    const source = str(e.source, 300);
    const d = Number(e.durationSec);
    seen.add(id);
    out.push({
      id,
      title,
      kind,
      file,
      burnedCaptions: e.burnedCaptions !== false,
      ...(source && /^https:\/\//.test(source) ? { source } : {}),
      ...(Number.isFinite(d) && d > 0 ? { durationSec: d } : {}),
      ...(poster && IMAGE.test(poster) && inside(dir, poster) ? { poster } : {}),
      ...(captions && CAPTIONS.test(captions) && inside(dir, captions) ? { captions } : {}),
    });
  }
  return out;
}

const galleryUrl = (name: string) => `/api/gallery/${encodeURIComponent(name)}`;
export const galleryCaptionsUrl = (id: string) => `/api/gallery/captions/${encodeURIComponent(id)}`;

/**
 * A gallery video's captions as WebVTT, or undefined when the folder holds none for it. The captions
 * come from the manifest's `captions` file when it names one, else from a file beside the video with
 * the same base name (<video>.vtt, else <video>.captions.json). A .vtt is served as is; a .json holds
 * film-style timed words ({captions: [{t0, t1, words: [{w}]}]}) and is turned into WebVTT.
 */
export function galleryCaptionsVtt(id: string, dir = galleryDir(), videos = loadGallery(dir)): string | undefined {
  if (!dir || !ID.test(id)) return undefined;
  const v = videos.find((e) => e.id === id);
  if (!v) return undefined;
  const base = v.file.replace(/\.mp4$/, "");
  for (const name of [v.captions, `${base}.vtt`, `${base}.captions.json`]) {
    if (!name || !CAPTIONS.test(name)) continue;
    const f = inside(dir, name);
    if (!f) continue;
    try {
      if (name.endsWith(".vtt")) {
        const t = fs.readFileSync(f, "utf8");
        if (t.trimStart().startsWith("WEBVTT")) return t;
      } else {
        const vtt = captionsToVtt((JSON.parse(fs.readFileSync(f, "utf8")) as { captions?: unknown }).captions);
        if (vtt) return vtt;
      }
    } catch {
      /* a torn file falls through to the next source */
    }
  }
  return undefined;
}

/** The list the page renders, with the file names swapped for URLs. */
export const galleryItems = (dir = galleryDir()): GalleryItem[] => {
  const videos = loadGallery(dir);
  return videos.map(({ file, poster, captions, burnedCaptions, ...v }) => ({
    ...v,
    src: galleryUrl(file),
    ...(poster ? { poster: galleryUrl(poster) } : {}),
    ...(!burnedCaptions && galleryCaptionsVtt(v.id, dir, videos) ? { captions: galleryCaptionsUrl(v.id) } : {}),
  }));
};

/** A gallery file by name, only if the manifest lists it: anything else, including any path, is not found. */
export function galleryFile(name: string, dir = galleryDir()): string | undefined {
  if (!dir || !(VIDEO.test(name) || IMAGE.test(name))) return undefined;
  const listed = loadGallery(dir).some((v) => v.file === name || v.poster === name);
  return listed ? inside(dir, name) : undefined;
}

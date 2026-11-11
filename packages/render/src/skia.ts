/**
 * Skia renderer: draws every frame with @napi-rs/canvas in worker threads and streams raw pixels to
 * ffmpeg, instead of screenshotting a headless Chrome page per frame (about 35 ms a frame, most of it
 * the screenshot). One Chrome page still runs once per film, to lay out text and report where each
 * caption sits, so both renderers put every word on the same pixels.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { chromium } from "playwright-core";
import { workerCount } from "./workers.js";
import type { Film } from "./film.js";
import { stageHtml } from "./stage.js";
import { findChrome, chromiumArgs, type CaptionSpot } from "./capture.js";
import { FONT_DIR, HAND_FONTS } from "./measure.js";
import { sampleTimes } from "./framecheck.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where Chrome laid out the stage's text and HUD (see skia/probe.js). */
export interface SkiaLayout {
  pathLen: (number | null)[];
  text: ({ xs: number[]; y: number; bb: { x: number; y: number; w: number; h: number } } | null)[];
  head: { x: number; base: number; lineTop: number; lineH: number };
  brand: { x: number; base: number };
  caps: ({ x: number; y: number; w: number; h: number; xs: number[]; base: number } | null)[];
  end: { title: Word[]; lines: Word[]; credit: { x: number; y: number; w: number; h: number; words: Word[] } | null } | null;
}
interface Word {
  w: string;
  x: number;
  y: number;
}

/** The TTF files for the film's fonts: the hand font is whichever bundled font the film embeds. */
function skiaFonts(film: Film): { hand: string; sans: string } {
  const sans = path.join(FONT_DIR, "Nunito-Variable.ttf");
  const data = film.fonts?.hand ?? "";
  for (const f of Object.values(HAND_FONTS)) {
    const b64 = fs.readFileSync(path.join(FONT_DIR, f.woff2)).toString("base64");
    if (data.endsWith(b64)) return { hand: path.join(FONT_DIR, f.ttf), sans };
  }
  return { hand: path.join(FONT_DIR, HAND_FONTS.excalifont.ttf), sans };
}

/** Open the stage once in Chrome: the caption report the frame check relies on, and the text layout. */
async function probeStage(film: Film, html: string): Promise<{ captions: CaptionSpot[]; layout: SkiaLayout }> {
  const browser = await chromium.launch({ executablePath: findChrome(), args: chromiumArgs() });
  try {
    const page = await browser.newPage({ viewport: { width: film.width, height: film.height }, deviceScaleFactor: 1 });
    await page.goto("file://" + html);
    await page.evaluate(() => (window as any).ready);
    const captions: CaptionSpot[] = await page.evaluate(() => (window as any).captionReport ?? []);
    const layout: SkiaLayout = await page.evaluate(fs.readFileSync(path.join(here, "skia/probe.js"), "utf8"));
    return { captions, layout };
  } finally {
    await browser.close();
  }
}

/**
 * How many Skia threads to draw on. With a hardware encoder the CPU is all theirs (one per spare core, at
 * most 8). With libx264 the encoder is the slow part and needs the cores: two to four drawing threads keep
 * it fed, and more only slow it down (on 8 cores: 2 threads 27 s, 4 threads 26 s, 7 threads 39 s).
 */
export function skiaWorkers(hardwareEncoder = false, cpus = os.cpus().length) {
  return hardwareEncoder ? Math.max(1, Math.min(8, cpus - 1)) : Math.max(2, Math.min(4, Math.floor(cpus / 3)));
}

/**
 * Draw frames on `workers` threads and hand them to `write` strictly in order. At most `limit` frames are
 * ever drawn-but-not-written (raw 1080p frames are 8 MB each), and `write` is awaited, so a slow ffmpeg
 * holds the drawing back instead of frames piling up in memory.
 */
export async function pumpFrames<B>(o: {
  frames: number[];
  workers: number;
  limit: number;
  draw: (worker: number, frame: number) => Promise<B>;
  write: (frame: number, buf: B) => Promise<void> | void;
}): Promise<{ peakHeld: number }> {
  const limit = Math.max(1, o.limit);
  const ready = new Map<number, B>();
  let next = 0,
    written = 0,
    peakHeld = 0,
    failed: unknown;
  let waiters: (() => void)[] = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };
  let flushing = Promise.resolve();
  const flush = async () => {
    while (!failed && ready.has(written)) {
      const b = ready.get(written)!;
      ready.delete(written);
      await o.write(o.frames[written], b);
      written++;
      wake();
    }
  };
  const fail = (e: unknown) => {
    failed ??= e;
    wake();
  };
  const run = async (w: number) => {
    while (!failed && next < o.frames.length) {
      if (next - written >= limit) {
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      const i = next++;
      peakHeld = Math.max(peakHeld, next - written);
      let b: B;
      try {
        b = await o.draw(w, o.frames[i]);
      } catch (e) {
        fail(e);
        return;
      }
      ready.set(i, b);
      flushing = flushing.then(flush).catch(fail);
    }
  };
  await Promise.all([...Array(Math.max(1, o.workers)).keys()].map(run));
  await flushing;
  if (failed) throw failed;
  return { peakHeld };
}

/**
 * Render frames with Skia. Each frame's raw RGBA pixels go to `onFrame` in frame order; the frames the
 * frame check reads are also written to `dir` as JPEGs (f000123.jpg), like the Chrome renderer does.
 */
export async function captureFramesSkia(
  film: Film,
  dir: string,
  opts: {
    workers?: number;
    hardwareEncoder?: boolean;
    only?: number[];
    limit?: number;
    onFrame: (f: number, rgba: Buffer) => Promise<void> | void;
    onProgress?: (done: number, total: number) => void;
  },
) {
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, "stage.html");
  fs.writeFileSync(html, stageHtml(film));
  const total = Math.ceil(film.duration * film.fps);
  const frames = opts.only ?? [...Array(total).keys()];
  const { captions, layout } = await probeStage(film, html);
  const jpegFrames = [...new Set(sampleTimes(film).map((t) => Math.round(t * film.fps)))];
  const n = workerCount(opts.workers, skiaWorkers(opts.hardwareEncoder), frames.length);
  const { fonts: _drop, ...plain } = film;
  const pool = await Promise.all(
    [...Array(n).keys()].map(
      () =>
        new Promise<Worker>((res, rej) => {
          const w = new Worker(new URL("./skia/worker.mjs", import.meta.url), {
            workerData: { film: plain, layout, fonts: skiaFonts(film), jpegFrames },
          });
          w.once("message", () => res(w));
          w.once("error", rej);
        }),
    ),
  );
  let done = 0;
  try {
    const { peakHeld } = await pumpFrames<Buffer>({
      frames,
      workers: n,
      limit: opts.limit ?? n * 2,
      draw: (i, f) =>
        new Promise((res, rej) => {
          const w = pool[i];
          const onErr = (e: unknown) => rej(e);
          w.once("error", onErr);
          w.once("message", (m: { f: number; buf?: Uint8Array; jpg?: Uint8Array; error?: string }) => {
            w.off("error", onErr);
            if (m.error || !m.buf) return rej(new Error(`skia frame ${f}: ${m.error}`));
            if (m.jpg) fs.writeFileSync(path.join(dir, `f${String(f).padStart(6, "0")}.jpg`), m.jpg);
            res(Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength));
          });
          w.postMessage({ f });
        }),
      write: async (f, buf) => {
        await opts.onFrame(f, buf);
        done++;
        if (done % 30 === 0) opts.onProgress?.(done, frames.length);
      },
    });
    return { html, total, captions, peakHeld };
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
}

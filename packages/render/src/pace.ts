import type { Film, FElement, CamKey } from "./film.js";
import { NODE, type Box } from "./layout.js";
import { textWidth } from "./measure.js";
import { cameraAt } from "./check.js";

import { MIN_CUTS_PER_MIN } from "@explanimate/core";

/** Pacing limits the composer works to; ExplainSpec.tempo in @explanimate/core fills these from the brief. */
export interface TempoLimits {
  id: string;
  minBeat: number;
  maxCutsPerMin: number;
  move: number;
  tail: number;
}
export const DEFAULT_TEMPO: TempoLimits = { id: "steady", minBeat: 4.0, maxCutsPerMin: 13, move: 1.1, tail: 0.8 };

/** Smallest on-screen height, in pixels of a 1080p frame, for a box's name in a resting shot. */
export const MIN_LABEL_PX = 26;
/** Longest a too-wide overview may rest before the camera moves in to a readable framing. */
export const OVERVIEW_S = 1.0;
/** Widest view (world units) in which a box's name is still MIN_LABEL_PX tall on screen. */
export const readableWidth = (film: { width: number; height: number }) => (NODE.kwSize * film.width * film.height) / (1080 * MIN_LABEL_PX);

export interface Span {
  start: number;
  end: number;
  kind: string;
}

/** World-space box an element covers. */
export function boxOf(e: FElement): Box | undefined {
  if (e.k === "img") return { x: e.x, y: e.y, w: e.w, h: e.h };
  if (e.k === "text") {
    const w = textWidth(e.text, e.size),
      a = e.anchor ?? "start";
    return { x: a === "middle" ? e.x - w / 2 : a === "end" ? e.x - w : e.x, y: e.y - e.size * 0.95, w, h: e.size * 1.25 };
  }
  const pts: number[] = e.k === "dot" ? e.pts.flat() : (e.d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
  if (pts.length < 2) return undefined;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const union = (bs: Box[]): Box | undefined => {
  if (!bs.length) return undefined;
  const x0 = Math.min(...bs.map((b) => b.x)),
    y0 = Math.min(...bs.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
};
const overlaps = (b: Box, v: Box) => b.x < v.x + v.w && v.x < b.x + b.w && b.y < v.y + v.h && v.y < b.y + b.h;
const intersect = (a: Box, b: Box): Box | undefined => {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    w = Math.min(a.x + a.w, b.x + b.w) - x,
    h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
};
const inside = (b: Box, v: Box) => b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h;

/** Camera view that frames b below the heading and above the captions (same margins as the composer). */
function fitView(film: Film, b: Box, minW: number): Omit<CamKey, "t" | "move"> {
  const W = film.width,
    H = film.height,
    SAFE = { top: 160, bottom: CAPTION_BAND + 10, side: 110 };
  const bw = Math.max(b.w + 120, minW),
    bh = Math.max(b.h + 120, (minW * (H - SAFE.top - SAFE.bottom)) / (W - 2 * SAFE.side));
  const s = Math.min((W - 2 * SAFE.side) / bw, (H - SAFE.top - SAFE.bottom) / bh);
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2,
    screenCy = SAFE.top + (H - SAFE.top - SAFE.bottom) / 2;
  return { x: cx - W / s / 2, y: cy - screenCy / s, w: W / s, h: H / s };
}

/**
 * Scenes that draw new boxes, where a wide shot must not hide their names. A walkthrough
 * or recap shows the whole board on purpose: the moving dot or the summary is the point.
 */
/** News-style cut-ins: one chart or timeline framed whole. */
export const CUT_IN_KINDS = new Set(["chart", "timeline", "map"]);

export const READ_KINDS = new Set(["layer", "scale", "notes", "chart", "timeline", "map", "board", "establish"]);

/**
 * Every moment the picture changes: an element starting to appear, the camera
 * moving or a heading. Caption phrases do not count: a new line
 * of text over a still board still reads as a frozen frame.
 */
export function changes(film: Film): [number, number][] {
  const out: [number, number][] = [];
  for (const e of film.elements) if (seen(film, e)) out.push([e.t0, e.t0 + e.dur]);
  for (const k of film.camera) out.push([k.t, k.t + k.move]);
  for (const h of film.headings) out.push([h.t0, h.t0 + 0.5]);
  for (const f of film.fades) out.push([f.t - f.dur, f.t + f.dur]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** Smallest share of the frame a new element must cover to read as the picture changing. */
export const SEEN_SHARE = 0.003;

/**
 * Whether an element is big enough on screen, when it appears, to count as a change.
 * A small label, a moving dot or a thin wire drawn into a wide shot leaves the frame looking frozen.
 */
function seen(film: Film, e: FElement): boolean {
  if (!film.camera.length) return true;
  if (e.k === "dot") return false;
  const b = boxOf(e);
  if (!b) return false;
  const v = cameraAt(film, e.t0);
  const w = Math.min(b.x + b.w, v.x + v.w) - Math.max(b.x, v.x),
    h = Math.min(b.y + b.h, v.y + v.h) - Math.max(b.y, v.y);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (v.w * v.h) >= SEEN_SHARE;
}

/** Stretches inside [from, to] where nothing visible changes. */
export function stillGaps(film: Film, from: number, to: number): { t0: number; t1: number }[] {
  const gaps: { t0: number; t1: number }[] = [];
  let busy = from;
  for (const [a, b] of changes(film)) {
    if (b < from || a > to) continue;
    if (a > busy) gaps.push({ t0: busy, t1: a });
    busy = Math.max(busy, b);
  }
  if (to > busy) gaps.push({ t0: busy, t1: to });
  return gaps;
}

export const bigChange = (a: Omit<CamKey, "t" | "move">, b: Omit<CamKey, "t" | "move">) =>
  Math.abs(Math.log(b.w / a.w)) > 0.15 || Math.hypot(b.x + b.w / 2 - a.x - a.w / 2, b.y + b.h / 2 - a.y - a.h / 2) / a.w > 0.15;

/** Times a new shot starts: camera moves that change the framing a lot (a slow push is not a new shot). */
export function shotStarts(film: Film): number[] {
  const keys = [...film.camera].sort((a, b) => a.t - b.t),
    out: number[] = [];
  for (const k of keys.slice(1)) if (bigChange(cameraAt({ ...film, camera: keys }, k.t - 1e-3), k)) out.push(k.t);
  return out;
}

/** Opacity of an element's group at time t (1 when it has no group keys). */
function opacityAt(film: Film, e: FElement, t: number): number {
  const k = e.g ? film.groups?.[e.g] : undefined;
  if (!k?.length) return 1;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++)
    if (t < k[i][0]) {
      const [t0, v0] = k[i - 1],
        [t1, v1] = k[i];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-6, t1 - t0);
    }
  return k[k.length - 1][1];
}
const visibleAt = (film: Film, e: FElement, t: number) => t >= e.t0 && opacityAt(film, e, t) > 0.05;

/** Slide view v so it lies inside outer (when it is smaller). */
function within(v: Box, outer: Box): Box {
  const x = v.w <= outer.w ? Math.min(Math.max(v.x, outer.x), outer.x + outer.w - v.w) : v.x;
  const y = v.h <= outer.h ? Math.min(Math.max(v.y, outer.y), outer.y + outer.h - v.h) : v.y;
  return { ...v, x, y };
}

/** The smallest 16:9 view holding both views, centred on them. */
function joinViews(a: Box, b: Box, film: Film): Box {
  const u = union([a, b])!,
    r = film.width / film.height;
  const w = Math.max(u.w, u.h * r),
    h = w / r;
  return { x: u.x + u.w / 2 - w / 2, y: u.y + u.h / 2 - h / 2, w, h };
}

export interface PaceReport {
  tempo: string;
  /** new shots a minute, end card excluded */
  cutsPerMin: number;
  shots: number;
  /** shortest time between two shot starts (the opening counts as one) */
  shortestHold: number;
  medianHold: number;
  minBeat: number;
  maxCutsPerMin: number;
  /** camera moves still overlapping a ring, arrow or dot being drawn */
  panDuringDraw: number;
  /** hard rules broken: a hold under the minimum beat, too many cuts, a pan while drawing */
  problems: string[];
  /** soft targets missed, such as fewer than MIN_CUTS_PER_MIN cuts when long holds could not be split cleanly */
  notes: string[];
}

/** Measure the pacing of a finished film. */
export function paceReport(film: Film, tempo: TempoLimits): PaceReport {
  const end = film.end?.t0 ?? film.duration;
  const shots = shotStarts(film).filter((t) => t < end);
  const marks = markSpans(film);
  const keys = [...film.camera].sort((a, b) => a.t - b.t);
  const pans = keys.filter((k, i) => i > 0 && k.move > 0 && marks.some(([a, b]) => k.t < b - OVERLAP_OK && k.t + k.move > a + OVERLAP_OK)),
    panning = pans.length;
  const starts = [0, ...shots],
    holds = starts.map((t, i) => (starts[i + 1] ?? end) - t).filter((d) => d > 0);
  const sorted = [...holds].sort((a, b) => a - b);
  const r: PaceReport = {
    tempo: tempo.id,
    cutsPerMin: Number(((shots.length + 1) / (end / 60)).toFixed(2)),
    shots: shots.length + 1,
    shortestHold: Number((sorted[0] ?? end).toFixed(2)),
    medianHold: Number((sorted[sorted.length >> 1] ?? end).toFixed(2)),
    minBeat: tempo.minBeat,
    maxCutsPerMin: tempo.maxCutsPerMin,
    panDuringDraw: panning,
    problems: [],
    notes: [],
  };
  if (r.shortestHold < tempo.minBeat - 0.05) r.problems.push(`a shot holds only ${r.shortestHold} s (minimum ${tempo.minBeat} s)`);
  if (r.cutsPerMin > tempo.maxCutsPerMin + 0.01) r.problems.push(`${r.cutsPerMin} cuts a minute (maximum ${tempo.maxCutsPerMin})`);
  if (r.cutsPerMin < MIN_CUTS_PER_MIN - 0.01)
    r.notes.push(`${r.cutsPerMin} cuts a minute, under the ${MIN_CUTS_PER_MIN} target: the long holds left had no clean place to split`);
  if (panning)
    r.problems.push(`camera moves at ${pans.map((k) => `${k.t.toFixed(1)} s`).join(", ")} overlap a ring, arrow or dot being drawn`);
  return r;
}

/**
 * Overlap tolerated between a camera move and a drawing at either end: an eased move has
 * shifted the view by well under one percent 0.1 s from its start or end.
 */
const OVERLAP_OK = 0.1;

/** When annotations (rings, arrows, walking dots) are being drawn, merged into spans. */
function markSpans(film: Film): [number, number][] {
  const sp = film.elements
    .filter((e) => e.mark && e.dur > 0)
    .map((e) => [e.t0, e.t0 + e.dur] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sp) {
    const l = out.at(-1);
    if (l && s[0] <= l[1] + 0.05) l[1] = Math.max(l[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/**
 * Pace a composed film, in place, to the tempo the brief chose.
 * 1. every camera move eases over the tempo's move time
 * 2. a wide overview too small to read glides in, one readable beat at a time
 * 3. shots never start closer than the tempo's minimum beat, and stay under its cuts a minute:
 *    two close moves become one framing that holds both targets
 * 4. a slow push through a long still stretch, so a held shot is not a frozen frame
 * 5. the camera never moves while a ring, arrow or dot is being drawn
 */
export function applyTempo(film: Film, scenes: Span[], tempo: TempoLimits = DEFAULT_TEMPO): PaceReport {
  // keys this pass adds: pushes get refitted around drawings; readability glides and split shots get
  // dropped when nothing else keeps them clear of a drawing
  const pushes = new WeakSet<CamKey>(),
    optional = new WeakSet<CamKey>();
  const sortCam = () => film.camera.sort((a, b) => a.t - b.t);
  sortCam();
  for (const k of film.camera) if (k.move > 0 && k.move < tempo.move) k.move = tempo.move;
  const boxes = film.elements.map((e) => ({ e, b: boxOf(e) })).filter((x): x is { e: FElement; b: Box } => !!x.b);
  const beat = Math.max(tempo.minBeat, 60 / tempo.maxCutsPerMin);

  // 2. wide shots stay readable: rest a moment on the overview, then glide in to a readable
  // framing that follows what is being drawn, or sweeps across the board when nothing new appears
  const RW = readableWidth(film);
  // placement can widen a shot past a cut mark only up to 1.5x readable width: a lit mark
  // spanning more than that can never be fixed into a closeup, so new shots keep it whole
  const tooWideToFix = (b: Box) => Math.max(b.w, (b.h * film.width) / film.height) > RW * 1.5;
  const keys = [...film.camera];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.w <= RW * 1.05) continue;
    const sc = scenes.find((s) => k.t >= s.start - 0.05 && k.t < s.end);
    if (!sc || !READ_KINDS.has(sc.kind)) continue;
    const hold = keys[i + 1]?.t ?? sc.end,
      end = Math.min(hold, sc.end);
    const wide: Box = { x: k.x, y: k.y, w: k.w, h: k.h };
    const shown = (until: number) => boxes.filter(({ e, b }) => e.k !== "path" && e.k !== "dot" && e.t0 < until && overlaps(b, wide));
    // a lit mark the overview keeps whole but no readable widening can take in: a glide that would cut it holds the wide shot instead
    const cutsLitMark = (v: Box, until: number) =>
      boxes.some(
        ({ e, b }) =>
          e.k === "path" && e.mark && tooWideToFix(b) && visibleAt(film, e, until) && overlaps(b, wide) && overlaps(b, v) && !inside(b, v),
      );
    // the glides from t on: each frames what is drawn next, readably, and holds at least a beat
    const glides = (from: number): CamKey[] => {
      const out: CamKey[] = [],
        done = new Set<FElement>();
      let t = from,
        sweep = 0;
      while (t < end - tempo.minBeat * 0.5) {
        let tn = t + beat < end - 0.9 ? t + beat : hold;
        const fresh = boxes
          .filter(({ e, b }) => e.k !== "dot" && e.k !== "path" && !done.has(e) && e.t0 + e.dur >= t && e.t0 < tn && inside(b, wide))
          .sort((a, b) => a.e.t0 + a.e.dur - b.e.t0 - b.e.dur);
        let f: Box | undefined;
        for (const x of fresh) {
          const u = union(f ? [f, x.b] : [x.b])!,
            fin = x.e.t0 + x.e.dur;
          // the next glide starts in time to arrive as the word finishes, but never before a full beat has passed
          const next = Math.max(t + tempo.minBeat, fin - tempo.move);
          // (only when there is room left for that glide and it arrives as the word finishes: otherwise this
          // framing widens to take the word in too, since a word must be whole on screen as it finishes)
          const room = next < Math.min(tn, end - tempo.minBeat * 0.5) && next + tempo.move <= fin + 0.05;
          if (f && room && (u.w > RW * 0.85 || u.h > (RW * 0.85 * film.height) / film.width)) {
            tn = next;
            break;
          }
          f = u;
          done.add(x.e);
        }
        const swept = !f;
        if (!f) {
          const all = union(shown(tn).map((x) => x.b));
          if (!all) break;
          const tall = all.h / all.w > film.height / film.width,
            half = sweep++ % 2;
          f = tall ? { ...all, y: all.y + (half * all.h) / 2, h: all.h / 2 } : { ...all, x: all.x + (half * all.w) / 2, w: all.w / 2 };
        }
        let v: Box = fitView(film, f, RW * 0.7);
        if (swept && v.w > RW) {
          const cx = v.x + v.w / 2,
            cy = v.y + v.h / 2,
            h = (RW * film.height) / film.width;
          v = { x: cx - RW / 2, y: cy - h / 2, w: RW, h };
        }
        // a resting view should not slice a box or word in half: widen a little to take it in
        for (let j = 0; j < 3; j++) {
          const cut = shown(tn)
            .filter(({ b }) => overlaps(b, v) && !inside(b, v))
            .map((x) => x.b);
          if (!cut.length) break;
          const w = union([v, ...cut])!,
            g = fitView(film, w, 0);
          if (g.w > RW * 1.15) break;
          v = g;
        }
        if (cutsLitMark(v, tn)) {
          t = tn;
          continue;
        }
        out.push({ t, ...within(v, wide), move: tempo.move });
        t = tn;
      }
      return out;
    };
    // the overview is a shot of its own, so it holds a full beat before the first glide
    // ...unless something new would be drawn while it holds: a word drawn in a far-off shot is unreadable,
    // so the camera goes straight to the first readable framing instead
    const holdUntil = k.t + Math.max(tempo.minBeat, k.move + OVERVIEW_S);
    const early = boxes.some(({ e, b }) => (e.k === "text" || e.k === "img") && e.t0 >= k.t - 0.05 && e.t0 < holdUntil && inside(b, wide));
    const plan = glides(early ? k.t : holdUntil);
    if (early && plan.length) {
      const [first, ...rest] = plan;
      Object.assign(k, { x: first.x, y: first.y, w: first.w, h: first.h });
      plan.splice(0, plan.length, ...rest);
    }
    for (const key of plan) {
      optional.add(key);
      film.camera.push(key);
    }
    sortCam();
  }

  // 2c. a long hold is split in two: the camera moves in on what is drawn (or was just drawn) in its
  // second half, so the video lands between MIN_CUTS_PER_MIN and the tempo's maximum. A hold needs room
  // for two full beats and a short move; the slow tempo keeps a whole move between them, so it splits less
  const target = 60 / ((MIN_CUTS_PER_MIN + tempo.maxCutsPerMin) / 2);
  const room = 2 * tempo.minBeat + (tempo.minBeat > 4 ? tempo.move : 0.3);
  for (const s of scenes) {
    // a chart or timeline is one full-frame graphic: pushing in on its last row would crop the first
    if (s.kind === "hook" || s.kind === "walkthrough" || CUT_IN_KINDS.has(s.kind)) continue;
    for (let n = 0; n < 3; n++) {
      sortCam();
      const pts = [s.start, ...shotStarts(film).filter((t) => t > s.start + 0.01 && t < s.end - 0.01), s.end];
      const seg = pts
        .slice(1)
        .map((b, i) => [pts[i], b])
        .find(([a, b]) => b - a >= target * 1.6 && b - a >= room);
      if (!seg) break;
      const [a, b] = seg,
        cur = cameraAt(film, a + tempo.move + 0.05);
      const marks = markSpans(film),
        lo = a + tempo.minBeat,
        hi = b - tempo.minBeat;
      const ideal = Math.min(hi, Math.max(lo, (a + b) / 2 - tempo.move));
      const cands = [...Array(Math.floor((hi - lo) / 0.1 + 1e-6) + 1).keys()]
        .map((i) => lo + i * 0.1)
        .sort((x, y) => Math.abs(x - ideal) - Math.abs(y - ideal));
      const m = cands.find((t) => !marks.some(([p, q]) => t < q + 0.05 && t + tempo.move > p - 0.05));
      if (m === undefined) break;
      const drawn = (t0: number, t1: number) => boxes.filter(({ e }) => e.k !== "dot" && e.t0 >= t0 && e.t0 < t1).map((x) => x.b);
      const f = union(drawn(m, b)) ?? union(drawn(a, m).filter((x) => overlaps(x, cur)));
      if (!f) break;
      // the tightest framing around it that slices no visible box, word, or unfixably wide ring, arrow or wire
      const vis = boxes
        .filter(
          ({ e, b: box }) =>
            (e.k !== "path" || (e.mark && tooWideToFix(box))) &&
            e.k !== "dot" &&
            (visibleAt(film, e, m + tempo.move) || visibleAt(film, e, b - 0.1)),
        )
        .map((x) => x.b);
      const base = fitView(film, f, Math.max(cur.w * 0.6, film.width * 0.8)),
        cx = base.x + base.w / 2,
        cy = base.y + base.h / 2;
      let v: Box | undefined;
      for (let w = base.w; !v && w <= Math.max(cur.w, RW) * 1.05; w *= 1.06) {
        const h = (w * film.height) / film.width;
        for (const [dx, dy] of [
          [0, 0],
          [-0.15, 0],
          [0.15, 0],
          [0, -0.15],
          [0, 0.15],
        ]) {
          const c: Box = { x: cx - w / 2 + dx * w, y: cy - h / 2 + dy * h, w, h };
          const safe: Box = {
            x: c.x + (110 / film.width) * w,
            y: c.y + (160 / film.height) * h,
            w: w * (1 - 220 / film.width),
            h: h * (1 - 380 / film.height),
          };
          if (inside(f, safe) && !vis.some((x) => overlaps(x, c) && !inside(x, c))) {
            v = c;
            break;
          }
        }
      }
      if (!v) break;
      if (!bigChange(cur, v) || v.w > Math.max(cur.w, RW) * 1.05) break;
      const key = { t: m, ...v, move: tempo.move };
      optional.add(key);
      film.camera.push(key);
    }
  }
  sortCam();

  const end = film.end?.t0 ?? film.duration;
  // nothing new appears outside view v between t0 and t1 (so the camera may leave early)
  const quiet = (t0: number, t1: number, v: Box) => boxes.every(({ e, b }) => e.t0 + e.dur < t0 || e.t0 >= t1 || inside(b, v));

  // 3. minimum beat and cuts a minute
  const beats = () => {
    for (let pass = 0; pass < 200; pass++) {
      sortCam();
      const cuts = shotStarts(film).filter((t) => t < end);
      const starts = [0, ...cuts];
      const gaps = starts.slice(1).map((t, i) => ({ a: starts[i], b: t, d: t - starts[i] }));
      const tooMany = (cuts.length + 1) / (end / 60) > tempo.maxCutsPerMin;
      const short = gaps.filter((g) => g.d < tempo.minBeat - 0.01);
      const pick = short[0] ?? (tooMany ? [...gaps].sort((x, y) => x.d - y.d)[0] : undefined);
      if (!pick) break;
      const ka = film.camera.find((k) => Math.abs(k.t - pick.a) < 1e-6) ?? film.camera[0];
      const kb = film.camera.find((k) => Math.abs(k.t - pick.b) < 1e-6)!;
      // a slow push is texture, not a shot: one that leaves too short a beat goes, rather than widening a real shot to take it in
      const push = pushes.has(kb) ? kb : pushes.has(ka) ? ka : undefined;
      if (push) {
        film.camera.splice(film.camera.indexOf(push), 1);
        continue;
      }
      const j = joinViews(ka, kb, film);
      // join the two framings when the result is still readable and not much wider; else hold the
      // first one a full beat and move on after it, and drop the move when the next one takes over
      if (j.w <= Math.max(ka.w, kb.w) * 1.35 && (j.w <= RW * 1.25 || Math.max(ka.w, kb.w) > RW)) {
        // the joined framing lands on the earlier key, unless that one is an extra move that would pan
        // across a drawing: then it lands on the planned key, on its own cue
        const drawing = film.elements.some((e) => e.mark && ka.t < e.t0 + e.dur - OVERLAP_OK && ka.t + ka.move > e.t0 + OVERLAP_OK);
        const [keep, drop] = optional.has(ka) && !optional.has(kb) && drawing ? [kb, ka] : [ka, kb];
        Object.assign(keep, { x: j.x, y: j.y, w: j.w, h: j.h });
        film.camera.splice(film.camera.indexOf(drop), 1);
      } else {
        const nt = pick.a + tempo.minBeat;
        const next = film.camera.find((k) => k.t > kb.t + 1e-6);
        if (next && nt + kb.move >= next.t - 0.1) film.camera.splice(film.camera.indexOf(kb), 1);
        else kb.t = nt;
      }
    }
    sortCam();
  };
  beats();

  // 4. no frozen holds: a slow push through any long still stretch
  for (const s of scenes) {
    // a walkthrough is never still: its dot is the motion
    if (s.kind === "walkthrough") continue;
    for (const g of stillGaps(film, s.start, s.end)) {
      if (g.t1 - g.t0 <= 1.6) continue;
      const cur = cameraAt(film, g.t0),
        z = Math.max(0.9, 1 - 0.03 * (g.t1 - g.t0));
      const onScreen = union(boxes.filter(({ e, b }) => e.k !== "dot" && e.t0 < g.t1 && overlaps(b, cur)).map((x) => x.b));
      const tight = onScreen && fitView(film, onScreen, (cur.w * z * (film.width - 220)) / film.width);
      const out = { x: cur.x - (cur.w * (1 / z - 1)) / 2, y: cur.y - (cur.h * (1 / z - 1)) / 2, w: cur.w / z, h: cur.h / z };
      const inward = { x: cur.x + (cur.w * (1 - z)) / 2, y: cur.y + (cur.h * (1 - z)) / 2, w: cur.w * z, h: cur.h * z };
      // words that finish appearing while this framing holds stay whole on screen
      const next = film.camera.find((k) => k.t >= g.t1 - 0.05);
      const until = next?.t ?? Infinity,
        m = (8 * cur.w) / film.width;
      const keepsNew = (v: Box) =>
        boxes.every(
          ({ e, b }) =>
            e.k !== "text" ||
            e.t0 + e.dur < g.t0 ||
            e.t0 + e.dur >= until ||
            inside({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }, v),
        );
      // a cut-in already fills the frame, so its slow move eases back instead of cropping an edge row
      const cutIn = scenes.some((s) => CUT_IN_KINDS.has(s.kind) && g.t0 >= s.start - 0.05 && g.t0 < s.end);
      const to = (cutIn ? [out] : [tight && tight.w < cur.w * 0.985 && tight.w > cur.w * 0.85 ? tight : undefined, inward, out]).find(
        (v): v is Box => !!v && keepsNew(v),
      );
      if (!to) continue;
      const key = { t: g.t0, ...to, move: g.t1 - g.t0 - 0.05 };
      pushes.add(key);
      film.camera.push(key);
      sortCam();
    }
  }

  // 5. hold still while a ring, arrow or dot is drawn: finish the move first, or draw it after the move
  // where each key sat before still() nudged it, so repeated passes never drift a move more than 1.5 s early
  const planned = new WeakMap<CamKey, number>();
  // drop an optional key (and a push into it, which was fitted to it) only if every word that finishes
  // appearing meanwhile still lands whole on screen
  const framed = (t0: number, t1: number) =>
    film.elements.every((e) => {
      if (e.k !== "text" || e.t0 + e.dur < t0 || e.t0 + e.dur >= t1) return true;
      const b = boxOf(e),
        v = cameraAt(film, e.t0 + e.dur);
      return !b || inside(b, v);
    });
  const dropKeeps = (i: number) => {
    const k = film.camera[i],
      prev = film.camera[i - 1],
      t1 = film.camera[i + 1]?.t ?? end;
    const gone = pushes.has(prev) ? [prev, k] : [k],
      t0 = gone[0].t,
      before = framed(t0, t1);
    film.camera = film.camera.filter((c) => !gone.includes(c));
    if (framed(t0, t1) || !before) return gone.length;
    film.camera.push(...gone);
    sortCam();
    return 0;
  };
  // moving a cut earlier must not leave the shot before it under the minimum beat (beats() would only move it back)
  const keepsBeat = (k: CamKey, t: number) => {
    const cuts = shotStarts(film);
    if (!cuts.some((c) => Math.abs(c - k.t) < 1e-6)) return true;
    const before = cuts.filter((c) => c < k.t - 1e-6).at(-1) ?? 0;
    return t - before >= tempo.minBeat - 0.01 || k.t - before < tempo.minBeat - 0.01;
  };
  const still = () => {
    for (const k of film.camera) if (!planned.has(k)) planned.set(k, k.t);
    for (let pass = 0; pass < 8; pass++) {
      const markEls = film.elements.filter((e) => e.mark && e.dur > 0);
      let moved = false,
        dropped = 0;
      for (let i = 1; i < film.camera.length; i++) {
        const k = film.camera[i],
          prev = film.camera[i - 1],
          nx = film.camera[i + 1]?.t ?? end;
        if (k.move <= 0) continue;
        const O = markEls.filter((e) => k.t < e.t0 + e.dur - OVERLAP_OK && k.t + k.move > e.t0 + OVERLAP_OK);
        if (!O.length) continue;
        const m = [Math.min(...O.map((e) => e.t0)), Math.max(...O.map((e) => e.t0 + e.dur))];
        moved = true;
        const sc = scenes.find((x) => m[0] >= x.start && m[0] < x.end);
        const early = m[0] - k.move - 0.05,
          settle = k.t + k.move + 0.05 - m[0];
        // the annotations drawing then, with everything else in their groups that comes after them in this scene
        const gs = new Set(O.map((e) => e.g ?? e.id));
        const late = film.elements.filter((e) => gs.has(e.g ?? e.id) && e.t0 >= m[0] - 1e-6 && (!sc || e.t0 < sc.end));
        // a later push gets refitted on the next pass, so only a real move or the scene end bounds the delay
        const nextReal = film.camera.slice(i + 1).find((c) => !pushes.has(c))?.t ?? end;
        // and everything delayed must still land inside the shot it then finishes in
        const canDelay = (d: number) =>
          late.every((e) => {
            const box = boxOf(e),
              done = e.t0 + d + e.dur;
            return done <= Math.min(sc?.end ?? end, nextReal) - 0.3 && (!box || inside(box, cameraAt(film, done)));
          });
        if (pushes.has(k)) {
          // a slow push stops before the drawing starts, or starts after it ends, or goes
          if (m[0] - k.t - 0.05 >= 0.8) k.move = m[0] - k.t - 0.05;
          else if (nx - m[1] - 0.1 >= 1.0) {
            k.t = m[1] + 0.05;
            k.move = nx - k.t - 0.05;
          } else {
            film.camera.splice(i, 1);
            i--;
          }
        } else if (
          early >= prev.t + Math.min(prev.move, tempo.move) &&
          (planned.get(k) ?? k.t) - early <= 1.5 &&
          quiet(early, k.t, k) &&
          keepsBeat(k, early)
        ) {
          // finish the move before the drawing starts
          k.t = early;
          prev.move = Math.min(prev.move, early - prev.t - 0.02);
        } else if (m[0] - 0.05 - k.t >= Math.max(0.75, tempo.move * 0.75) && quiet(k.t, m[0], k)) {
          // a brisker move that lands before the drawing starts, when the beat leaves no room to start earlier
          k.move = m[0] - 0.05 - k.t;
        } else if (settle <= 2.0 && canDelay(settle)) {
          // draw the annotations after the camera settles
          for (const e of late) e.t0 += settle;
        } else if (m[1] + 0.05 + k.move < nx - 0.2 && quiet(k.t, m[1] + 0.05, cameraAt(film, k.t))) {
          // wait for the drawing to finish, then move
          k.t = m[1] + 0.05;
        } else if (optional.has(k) && (dropped = dropKeeps(i))) {
          i -= dropped;
        } else moved = false;
      }
      sortCam();
      if (!moved) break;
    }
    // keys nudged onto the same moment collapse into the later one, and a move never runs into the next one
    film.camera = film.camera.filter((k, i, ks) => !(ks[i + 1] && ks[i + 1].t - k.t < 0.05));
    for (let i = 0; i + 1 < film.camera.length; i++) {
      const k = film.camera[i],
        n = film.camera[i + 1];
      if (k.move > 0 && k.t + k.move > n.t) k.move = Math.max(0.3, n.t - k.t - 0.02);
    }
  };
  // annotation fixes and beats can each nudge a move, so settle them together
  for (let n = 0; n < 4; n++) {
    still();
    const before = JSON.stringify(film.camera);
    beats();
    if (JSON.stringify(film.camera) === before) break;
  }
  clearCaptionBand(film);
  return paceReport(film, tempo);
}

/** Screen px at the bottom kept free of drawing for the captions, and at the top for the scene title. */
export const CAPTION_BAND = 170,
  TITLE_BAND = 150;

/**
 * Captions sit at one fixed spot at the bottom, on an opaque pill, so no held shot may put what it is
 * about under them: every element mostly on screen during the hold stays between the title and the
 * captions. A neighbour mostly off screen may pass under the pill, as video does under subtitles.
 * The camera first slides by as little as it can; only when no slide works does it widen, around
 * what the shot is about.
 */
function clearCaptionBand(film: Film) {
  const { width: W, height: H } = film,
    cam = film.camera;
  const lo = (H - CAPTION_BAND) / H,
    hi = TITLE_BAND / H;
  const area = (b: Box) => Math.max(1, b.w * b.h);
  for (let i = 0; i < cam.length; i++) {
    const k = cam[i],
      end = cam[i + 1]?.t ?? film.duration;
    const ts: number[] = [];
    for (let t = k.t + k.move; t < end; t += 0.25) ts.push(t);
    ts.push(Math.max(k.t + k.move, end - 0.01));
    // dimmed context (an earlier layer, say) may pass under the pill too: only what is lit counts
    const live = film.elements
      .filter((e) => ts.some((t) => t >= e.t0 && opacityAt(film, e, t) > 0.6))
      .map(boxOf)
      .filter((b): b is Box => !!b);
    // a long wire taller than the space between the bands is structure, not a subject: it may cross the band
    const about = (v: Box) =>
      live.filter((b) => {
        const x = intersect(b, v);
        return !!x && area(x) >= 0.5 * area(b) && b.h <= v.h * (lo - hi) * 0.6;
      });
    const clear = (v: Box, fs: Box[]) => fs.every((b) => b.y >= v.y + v.h * hi - 1 && b.y + b.h <= v.y + v.h * lo + 1);
    let focus = about(k);
    for (let pass = 0; pass < 6 && !clear(k, focus); pass++) {
      const c = union(focus)!;
      // slide: the smallest vertical shift that clears it, if the content fits between the bands at all
      if (c.h <= k.h * (lo - hi)) {
        const dy = c.y + c.h > k.y + k.h * lo ? c.y + c.h - (k.y + k.h * lo) : c.y - (k.y + k.h * hi);
        const v = { ...k, y: k.y + dy };
        const now = about(v);
        if (clear(v, now)) {
          k.y = v.y;
          break;
        }
        focus = [...new Set([...focus, ...now])];
        continue;
      }
      // widen around it, so it fits between title and captions with a little room
      const w = Math.max(k.w, c.w / 0.94, ((c.h / (lo - hi)) * W) / H / 0.97),
        h = (w * H) / W;
      k.x = c.x + c.w / 2 - w / 2;
      k.y = c.y + c.h / 2 - h * ((lo + hi) / 2);
      k.w = w;
      k.h = h;
      focus = [...new Set([...focus, ...about(k)])];
    }
  }
}

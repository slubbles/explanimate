/**
 * Line cards: the free visual a narration line asks for (kinetic words, chips, a terminal, an output,
 * a browser, a number, a before/after, a doodle), drawn on its own patch of the world far from the board.
 * The camera cuts to the card while its line is said and cuts back to the board shot it left.
 * Cards are spliced in after every camera pass, so tempo and placement never move them.
 */
import type { Beat, Theme, WordTiming } from "@explanimate/core";
import type { Film, FElement, CamKey, Heading } from "./film.js";
import { cameraAt } from "./check.js";
import { textWidth } from "./measure.js";
import { wrapText, type Box } from "./layout.js";

export const CARD_KINDS = ["kinetic", "chips", "terminal", "output", "browser", "number", "contrast", "doodle"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const isCardKind = (v: string): v is CardKind => (CARD_KINDS as readonly string[]).includes(v);

/** Shortest and longest time a card holds the screen, and the dip that hides each cut. */
export const CARD = { min: 2.0, max: 4.5, fade: 0.3, gapY: 1400, top: 20000 };

/** What a card needs from the film builder. */
export interface Pen {
  theme: Theme;
  els: FElement[];
  seed: number;
  id(p: string): string;
  rough(drawable: any, t0: number, dur: number, g?: string, anim?: "draw" | "pop" | "fade"): void;
  text(o: {
    text: string;
    x: number;
    y: number;
    size: number;
    color: string;
    anchor?: "start" | "middle";
    t0: number;
    dur?: number;
    g?: string;
    font?: "hand" | "sans";
    weight?: number;
    anim?: "wipe" | "fade";
    sketch?: boolean;
  }): void;
  img(o: { href?: string; x: number; y: number; w: number; h: number; t0: number; dur: number; g?: string; anim?: "pop" | "fade" }): void;
  setOp(g: string, t: number, v: number, dur?: number): void;
  cueNext(cue: "pop" | "whoosh"): void;
  icon(name: string): string | undefined;
}

export interface CardSlot {
  beat: Beat & { visual: CardKind };
  t0: number;
  t1: number;
  scene: string;
  words: WordTiming[];
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Index of the first word of `phrase` as said at or after `from`, exact words only; -1 when it is not said. */
export function saidAt(words: WordTiming[], phrase: string, from = 0): number {
  const split = (t: string) =>
    t
      .split(/[\s\-_/]+/)
      .map(norm)
      .filter(Boolean);
  const toks = split(phrase);
  if (!toks.length) return -1;
  // "agent-browser" may come back as one timed word or two; match on sub-tokens either way
  const flat: { tok: string; i: number }[] = [];
  words.forEach((w, i) => {
    if (i >= from) for (const tok of split(w.word)) flat.push({ tok, i });
  });
  for (let k = 0; k + toks.length <= flat.length; k++) if (toks.every((t, j) => flat[k + j].tok === t)) return flat[k].i;
  return -1;
}

/**
 * When each card line is on screen in one scene: from its anchor words to the start of the next line,
 * held 2 to 4.5 s, never before `from` (the hook's title card), never past the scene's end, never
 * overlapping the card before it. Lines whose anchor the voice never says get no card. A line too
 * close to the next to hold two seconds gets no card: the board holds instead of a flash.
 */
export function cardSlots(scene: string, beats: Beat[], words: WordTiming[], from: number, end: number): CardSlot[] {
  const out: CardSlot[] = [];
  let cursor = 0;
  const starts = beats.map((b) => {
    const head = b.line.split(/\s+/).slice(0, 3).join(" ");
    let i = saidAt(words, head, cursor);
    if (i < 0) i = saidAt(words, b.line.split(/\s+/).slice(0, 2).join(" "), cursor);
    if (i >= 0) cursor = i + 1;
    return i;
  });
  beats.forEach((b, k) => {
    if (!isCardKind(b.visual)) return;
    const ls = starts[k];
    let a = saidAt(words, b.anchor, Math.max(0, ls));
    // kinetic words appear as they are said, so the card opens on its first word, not on an earlier anchor
    const k0 = b.visual === "kinetic" ? saidAt(words, b.text.split(/\s+/).slice(0, 2).join(" "), Math.max(0, ls)) : -1;
    if (k0 > a && (a < 0 || words[k0].start - words[a].start > 0.5)) a = k0;
    if (a < 0) return;
    const nextLine = starts.slice(k + 1).find((i) => i >= 0);
    const lineEnd = nextLine !== undefined ? words[nextLine].start : words[words.length - 1].end + 0.3;
    // a card never comes late: a line said before cards may cut in is left to the board
    if (words[a].start < from - 0.3) return;
    const t0 = Math.max(words[a].start - 0.12, from);
    const t1 = Math.min(Math.max(lineEnd - 0.05, t0 + CARD.min), t0 + CARD.max, end - 0.25);
    if (t1 - t0 < CARD.min - 1e-6) return;
    // a card line right after another cuts straight from card to card
    const prev = out[out.length - 1];
    if (prev && t0 < prev.t1 + 0.4) {
      if (t0 - prev.t0 < CARD.min - 1e-6) return;
      prev.t1 = t0;
    }
    out.push({ beat: b as CardSlot["beat"], t0, t1, scene, words });
  });
  return out;
}

/** The card's patch of world: one 1920x1080 frame, far below everything else. */
export function cardBox(i: number, W = 1920, H = 1080): Box {
  return { x: 0, y: CARD.top + i * CARD.gapY, w: W, h: H };
}

/**
 * Cut the camera to each card and back: a still key on the card at its start, the board shot as it
 * would have been at its end, and nothing in between. A dip to the background hides each cut; the
 * heading steps aside for the card; board events the card would hide wait until it is gone.
 */
export function spliceCards(film: Film, cards: { box: Box; t0: number; t1: number; g: string }[]) {
  if (!cards.length) return;
  const before: Film = { ...film, camera: film.camera.map((k) => ({ ...k })) };
  let cam: CamKey[] = film.camera;
  for (const c of cards) {
    const back = cameraAt(before, c.t1);
    // a move under way when the card cut in resumes from where the board shot would be
    const hidden = cam.filter((k) => k.t > c.t0 && k.t < c.t1);
    cam = cam.filter((k) => k.t <= c.t0 || k.t >= c.t1);
    cam.push({ t: c.t0, ...c.box, move: 0 }, { t: c.t1, ...back, move: 0 });
    // the last move the card hid still lands where it was going
    const last = hidden[hidden.length - 1];
    if (last && last.t + last.move > c.t1 + 0.02) cam.push({ ...last, t: c.t1, move: last.t + last.move - c.t1 });
    film.fades.push({ t: c.t0, dur: CARD.fade }, { t: c.t1, dur: CARD.fade });
  }
  // a key that shares its time with a card's return goes after it, so the return never overrides a cut
  film.camera = cam
    .map((k, i) => ({ k, i }))
    .sort((a, b) => a.k.t - b.k.t || a.i - b.i)
    .map((x) => x.k);
  if (film.camera[0].t > 0) film.camera.unshift({ ...film.camera[0], t: 0 });
  // headings split around each card
  const hs: Heading[] = [];
  for (const h of film.headings) {
    let segs = [{ t0: h.t0, t1: h.t1 }];
    for (const c of cards)
      segs = segs.flatMap((s) =>
        (c.t1 <= s.t0 || c.t0 >= s.t1
          ? [s]
          : [
              { t0: s.t0, t1: c.t0 },
              { t0: c.t1, t1: s.t1 },
            ]
        ).filter((x) => x.t1 - x.t0 > 0.3),
      );
    hs.push(...segs.map((s) => ({ ...h, ...s })));
  }
  film.headings = hs;
  // what the board would draw while a card is up is drawn just after it, in the same order
  const cardGroups = new Set(cards.map((c) => c.g));
  for (const e of film.elements) {
    if (e.g && cardGroups.has(e.g.split("/")[0])) continue;
    for (let c = cards.find((c) => e.t0 > c.t0 - 0.05 && e.t0 < c.t1); c; c = cards.find((c) => e.t0 > c.t0 - 0.05 && e.t0 < c.t1))
      e.t0 = c.t1 + 0.15 + (e.t0 - c.t0) * 0.12;
  }
}

/**
 * One row of spoken words, built word by word and centred on what has been said so far, so a row
 * never sits off to the left while it builds. Each stage (the first k words) is its own subgroup,
 * laid out on its own width; it goes out the moment the next word comes in, which redraws the same
 * words a little to the left with the new word fading in on the end. Returns the subgroups, the last
 * of which stays up, so a caller can fade the finished row with them.
 */
export function buildRow(
  P: Pen,
  o: {
    words: { text: string; t: number; color: string }[];
    cx: number;
    y: number;
    size: number;
    g: string;
    key?: number;
    underline: (x0: number, x1: number, t: number, dur: number, g: string) => void;
  },
): string[] {
  const sp = textWidth(" ", o.size);
  const ws = o.words.map((w) => textWidth(w.text, o.size));
  const groups: string[] = [];
  for (let s = 1; s <= o.words.length; s++) {
    const gs = `${o.g}/s${s}`,
      t = o.words[s - 1].t;
    groups.push(gs);
    const width = ws.slice(0, s).reduce((a, b) => a + b, 0) + sp * (s - 1);
    let x = o.cx - width / 2;
    for (let k = 0; k < s; k++) {
      const fresh = k === s - 1;
      P.text({
        text: o.words[k].text,
        x,
        y: o.y,
        size: o.size,
        color: o.words[k].color,
        t0: t,
        dur: fresh ? 0.2 : 0.01,
        g: gs,
        anim: "fade",
        sketch: false,
      });
      if (k === o.key) {
        const uw = textWidth(o.words[k].text.replace(/[^\p{L}\p{N}]+$/u, ""), o.size);
        // the underline draws once, on the stage its word arrives in; later stages show it already there
        o.underline(x, x + uw, fresh ? t + 0.25 : t, fresh ? 0.35 : 0.01, gs);
      }
      x += ws[k] + sp;
    }
    if (s < o.words.length) P.setOp(gs, o.words[s].t, 0, 0.04);
  }
  return groups;
}

const CHIP_COLORS = ["blue", "green", "orange", "purple", "teal", "pink"] as const;
const BUTTON = /\b(button|log ?in|sign ?in|submit|search|send|buy|go|ok|next)\b/i;

/** Draw one card's content inside `box`, timed to its line. */
export function drawCard(P: Pen, gen: any, slot: CardSlot, box: Box, g: string) {
  const { beat: b, t0, t1, words } = slot;
  const th = P.theme,
    C = (c: (typeof CHIP_COLORS)[number] | "gray" | "red" | "yellow") => th.colors[c];
  const cx = box.x + box.w / 2,
    top = box.y + 150,
    bottom = box.y + box.h - 210,
    cy = (top + bottom) / 2;
  const said = (phrase: string, from = 0) => {
    const i = saidAt(words, phrase, from);
    return i >= 0 ? words[i].start : -1;
  };
  const at = (phrase: string, fallback: number) => {
    const t = said(phrase);
    return t >= t0 && t < t1 - 0.3 ? t - 0.05 : fallback;
  };
  const R = (d: any, s: number, dur: number) => P.rough(d, s, dur, g);
  const seed = () => P.seed++;
  const fitSize = (text: string, size: number, maxW: number, min = 34) => {
    let s = size;
    while (s > min && textWidth(text, s) > maxW) s -= 2;
    return s;
  };
  P.cueNext("whoosh");
  switch (b.visual) {
    case "kinetic": {
      const toks = b.text.split(/\s+/).filter(Boolean);
      let size = 124,
        rows = rowsOf(toks, size, 1560);
      while ((rows.length > 2 || rows.some((r) => r.w > 1560)) && size > 72) {
        size -= 6;
        rows = rowsOf(toks, size, 1560);
      }
      const lh = size * 1.3,
        y0 = cy + size * 0.35 - ((rows.length - 1) * lh) / 2;
      const key = keyIndex(toks);
      let from = Math.max(
          0,
          words.findIndex((w) => w.start >= t0 - 0.3),
        ),
        fb = t0 + 0.05;
      const lineSeed = seed();
      rows.forEach((r, ri) => {
        const y = y0 + ri * lh;
        const row = r.idx.map((i) => {
          const j = saidAt(words, toks[i], from);
          const t = j >= 0 && words[j].start < t1 - 0.2 ? Math.max(t0 + 0.05, words[j].start - 0.04) : fb;
          if (j >= 0) from = j + 1;
          fb = t + 0.12;
          return { text: toks[i], t, color: i === key ? C("orange") : th.ink };
        });
        // monotone times, so each stage really is followed by the next
        for (let k = 1; k < row.length; k++) row[k].t = Math.max(row[k].t, row[k - 1].t + 0.05);
        buildRow(P, {
          words: row,
          cx,
          y,
          size,
          g: `${g}/r${ri}`,
          key: r.idx.indexOf(key),
          underline: (x0, x1, t, dur, gs) =>
            P.rough(
              gen.line(x0, y + size * 0.2, x1, y + size * 0.24, { seed: lineSeed, stroke: C("orange"), strokeWidth: 6, roughness: 1.3 }),
              t,
              dur,
              gs,
            ),
        });
      });
      break;
    }
    case "chips": {
      const items = b.items.slice(0, 4);
      const size = 76,
        padX = 54,
        h = 150,
        gap = 60;
      const ws = items.map((it) => Math.min(800, textWidth(it, fitSize(it, size, 700)) + padX * 2));
      const rows: number[][] = [[]];
      let rw = 0;
      ws.forEach((w, i) => {
        if (rows[rows.length - 1].length && rw + gap + w > 1600) {
          rows.push([]);
          rw = 0;
        }
        rw += (rw ? gap : 0) + w;
        rows[rows.length - 1].push(i);
      });
      const label = b.text.trim();
      const blockH = rows.length * h + (rows.length - 1) * 50 + (label ? 110 : 0);
      let y = cy - blockH / 2;
      if (label) {
        P.text({
          text: label,
          x: cx,
          y: y + 56,
          size: fitSize(label, 56, 1500),
          color: C("gray"),
          anchor: "middle",
          t0: t0 + 0.05,
          dur: 0.4,
          g,
          anim: "fade",
          sketch: false,
        });
        y += 110;
      }
      let fb = t0 + 0.25;
      rows.forEach((r) => {
        const total = r.reduce((a, i) => a + ws[i], 0) + gap * (r.length - 1);
        let x = cx - total / 2;
        for (const i of r) {
          const t = Math.max(at(items[i], fb), fb - 0.2);
          fb = t + 0.35;
          const col = C(CHIP_COLORS[i % CHIP_COLORS.length]);
          P.cueNext("pop");
          R(gen.rectangle(x, y, ws[i], h, { seed: seed(), stroke: col, strokeWidth: 4, roughness: 1.1, bowing: 1.2 }), t, 0.4);
          P.text({
            text: items[i],
            x: x + ws[i] / 2,
            y: y + h / 2 + 20,
            size: fitSize(items[i], size, ws[i] - padX * 2),
            color: th.ink,
            anchor: "middle",
            t0: t + 0.15,
            dur: 0.3,
            g,
            sketch: false,
          });
          x += ws[i] + gap;
        }
        y += h + 50;
      });
      break;
    }
    case "terminal": {
      const w = 1560,
        h = 430,
        x = cx - w / 2,
        y = cy - h / 2;
      const fill = "#1d2230";
      R(
        gen.rectangle(x, y, w, h, { seed: seed(), stroke: th.ink, strokeWidth: 3.5, roughness: 0.9, fill, fillStyle: "solid" }),
        t0 + 0.02,
        0.35,
      );
      ["#ff6b6b", "#ffd166", "#06d6a0"].forEach((c, i) =>
        R(
          gen.circle(x + 50 + i * 44, y + 46, 22, { seed: seed(), stroke: c, fill: c, fillStyle: "solid", roughness: 0.6 }),
          t0 + 0.15,
          0.2,
        ),
      );
      const cmd = `$ ${b.text.trim().replace(/^\$\s*/, "")}`;
      const size = fitSize(cmd, 60, w - 140);
      const typeAt = Math.max(t0 + 0.35, at(b.anchor, t0 + 0.35));
      P.text({
        text: cmd,
        x: x + 70,
        y: y + h / 2 + 30,
        size,
        color: "#e8ecf4",
        t0: typeAt,
        dur: Math.min(1.6, 0.3 + cmd.length * 0.035),
        g,
        font: "sans",
        weight: 600,
        anim: "wipe",
        sketch: false,
      });
      break;
    }
    case "output": {
      const rows = b.items.slice(0, 5);
      const size = 58,
        lh = 100,
        w = 1460,
        title = b.text.trim();
      const h = 70 + rows.length * lh + (title ? 90 : 0),
        x = cx - w / 2,
        y = cy - h / 2;
      R(gen.rectangle(x, y, w, h, { seed: seed(), stroke: th.ink, strokeWidth: 3.2, roughness: 1.0 }), t0 + 0.02, 0.4);
      let ry = y + 92;
      if (title) {
        P.text({
          text: title,
          x: x + 60,
          y: y + 88,
          size: fitSize(title, 48, w - 120),
          color: C("gray"),
          t0: t0 + 0.2,
          dur: 0.35,
          g,
          anim: "fade",
          sketch: false,
        });
        ry += 90;
      }
      const step = Math.min(0.3, (t1 - t0 - 1.2) / Math.max(1, rows.length));
      rows.forEach((r, i) => {
        const rs = fitSize(r, size, w - 140);
        P.text({
          text: r,
          x: x + 70,
          y: ry + i * lh,
          size: rs,
          color: th.ink,
          t0: t0 + 0.35 + i * step,
          dur: 0.3,
          g,
          font: "sans",
          weight: 500,
          anim: "fade",
          sketch: false,
        });
        if (b.focus && norm(r).includes(norm(b.focus))) {
          const rwid = textWidth(r, rs) * 1.05 + 60;
          const tr = Math.min(t1 - 0.6, Math.max(t0 + 0.6 + rows.length * step, at(b.focus, 0)));
          R(
            gen.ellipse(x + 70 + rwid / 2 - 30, ry + i * lh - rs * 0.32, rwid, rs * 1.9, {
              seed: seed(),
              stroke: C("orange"),
              strokeWidth: 5,
              roughness: 1.4,
            }),
            tr,
            0.45,
          );
        }
      });
      break;
    }
    case "browser": {
      const w = 1500,
        h = 700,
        x = cx - w / 2,
        y = cy - h / 2;
      R(gen.rectangle(x, y, w, h, { seed: seed(), stroke: th.ink, strokeWidth: 3.5, roughness: 1.0 }), t0 + 0.02, 0.4);
      R(gen.line(x, y + 96, x + w, y + 96, { seed: seed(), stroke: th.ink, strokeWidth: 2.5, roughness: 0.8 }), t0 + 0.2, 0.25);
      ["#ff6b6b", "#ffd166", "#06d6a0"].forEach((c, i) =>
        R(
          gen.circle(x + 46 + i * 40, y + 48, 20, { seed: seed(), stroke: c, fill: c, fillStyle: "solid", roughness: 0.6 }),
          t0 + 0.25,
          0.2,
        ),
      );
      const url = b.text.trim() || "example.com";
      const uw = 980;
      R(gen.rectangle(x + 190, y + 22, uw, 54, { seed: seed(), stroke: C("gray"), strokeWidth: 2, roughness: 0.8 }), t0 + 0.3, 0.25);
      P.text({
        text: url,
        x: x + 220,
        y: y + 60,
        size: fitSize(url, 34, uw - 60, 22),
        color: C("gray"),
        t0: t0 + 0.4,
        dur: 0.4,
        g,
        font: "sans",
        anim: "wipe",
        sketch: false,
      });
      const items = b.items.slice(0, 4);
      const bh = 118,
        gap = 36,
        bw = 900,
        total = items.length * bh + (items.length - 1) * gap;
      let by = y + 96 + (h - 96 - total) / 2;
      const step = Math.min(0.3, (t1 - t0 - 1.4) / Math.max(1, items.length));
      items.forEach((it, i) => {
        const btn = BUTTON.test(it) && !/\b(box|field|input)\b/i.test(it);
        const label = it.replace(/^button\s+/i, "").replace(/\s+button$/i, "");
        const bx = cx - bw / 2,
          ts = t0 + 0.55 + i * step;
        R(
          gen.rectangle(bx, by, bw, bh, {
            seed: seed(),
            stroke: btn ? C("blue") : C("gray"),
            strokeWidth: 3,
            roughness: 1.0,
            ...(btn ? { fill: C("blue"), fillStyle: "solid" } : {}),
          }),
          ts,
          0.3,
        );
        P.text({
          text: label,
          x: btn ? cx : bx + 34,
          y: by + bh / 2 + 19,
          size: fitSize(label, 54, bw - 68),
          color: btn ? "#ffffff" : C("gray"),
          anchor: btn ? "middle" : "start",
          t0: ts + 0.15,
          dur: 0.3,
          g,
          anim: "fade",
          sketch: false,
        });
        if (b.focus && norm(it).includes(norm(b.focus).slice(0, 12))) {
          const tc = Math.min(t1 - 0.5, Math.max(t0 + 0.7 + items.length * step, at(b.focus, 0)));
          const px = cx + bw / 2 - 90,
            py = by + bh / 2 + 6;
          P.cueNext("pop");
          R(gen.circle(px, py, 70, { seed: seed(), stroke: C("red"), strokeWidth: 4, roughness: 1.2 }), tc + 0.2, 0.3);
          R(
            gen.polygon(
              [
                [px, py],
                [px + 14, py + 52],
                [px + 26, py + 32],
                [px + 46, py + 50],
                [px + 54, py + 42],
                [px + 34, py + 24],
                [px + 54, py + 14],
              ],
              { seed: seed(), stroke: th.ink, strokeWidth: 3, roughness: 0.6, fill: th.background, fillStyle: "solid" },
            ),
            tc,
            0.2,
          );
        }
        by += bh + gap;
      });
      break;
    }
    case "number": {
      const m = /^\s*([~≈]?)([\d,.]+)\s*(.*)$/.exec(b.text);
      const big = m ? `${m[1]}${m[2]}` : b.text.trim();
      const unit = m ? m[3] : "";
      const size = fitSize(big, 300, 1500, 120);
      const tn = Math.max(t0 + 0.05, at(b.text.split(/\s+/)[0] ?? b.anchor, t0 + 0.05));
      const n = m ? Number(m[2].replace(/,/g, "")) : NaN;
      const el: FElement = {
        k: "text",
        id: P.id("t"),
        text: big,
        x: cx,
        y: cy + (unit ? 40 : 100),
        size,
        color: C("orange"),
        anchor: "middle",
        t0: tn,
        dur: 0.6,
        g,
        anim: Number.isFinite(n) && n >= 3 && Number.isInteger(n) && !m![1] ? "count" : "fade",
      };
      if (el.k === "text" && el.anim === "count") el.count = { from: 0, to: n, suffix: "" };
      P.els.push(el);
      if (unit)
        P.text({
          text: unit,
          x: cx,
          y: cy + 170,
          size: fitSize(unit, 84, 1500),
          color: th.ink,
          anchor: "middle",
          t0: tn + 0.3,
          dur: 0.4,
          g,
          anim: "fade",
          sketch: false,
        });
      const uw = textWidth(big, size);
      R(
        gen.line(cx - uw / 2, cy + (unit ? 75 : 135), cx + uw / 2, cy + (unit ? 80 : 140), {
          seed: seed(),
          stroke: th.ink,
          strokeWidth: 6,
          roughness: 1.4,
        }),
        tn + 0.55,
        0.35,
      );
      break;
    }
    case "contrast": {
      const [a = "", z = ""] = b.items;
      const colW = 700,
        size = 70;
      const la = wrapText(a, size, colW, 3),
        lz = wrapText(z, size, colW, 3);
      const lh = size * 1.3;
      const xa = cx - 450,
        xz = cx + 450;
      const tz = Math.max(t0 + 0.8, Math.min(t1 - 0.8, at(z, t0 + (t1 - t0) * 0.45)));
      la.forEach((l, i) =>
        P.text({
          text: l,
          x: xa,
          y: cy - ((la.length - 1) * lh) / 2 + i * lh + 20,
          size,
          color: C("gray"),
          anchor: "middle",
          t0: t0 + 0.05 + i * 0.1,
          dur: 0.35,
          g,
          anim: "fade",
          sketch: false,
        }),
      );
      const aw = Math.max(...la.map((l) => textWidth(l, size)));
      R(
        gen.line(xa - aw / 2 - 10, cy + 10, xa + aw / 2 + 10, cy - 4, { seed: seed(), stroke: C("red"), strokeWidth: 6, roughness: 1.5 }),
        tz - 0.35,
        0.3,
      );
      R(
        gen.linearPath(
          [
            [cx - 70, cy],
            [cx + 70, cy],
          ],
          { seed: seed(), stroke: th.ink, strokeWidth: 5, roughness: 0.8 },
        ),
        tz - 0.15,
        0.25,
      );
      R(
        gen.linearPath(
          [
            [cx + 40, cy - 28],
            [cx + 72, cy],
            [cx + 40, cy + 28],
          ],
          { seed: seed(), stroke: th.ink, strokeWidth: 5, roughness: 0.6 },
        ),
        tz + 0.05,
        0.15,
      );
      lz.forEach((l, i) =>
        P.text({
          text: l,
          x: xz,
          y: cy - ((lz.length - 1) * lh) / 2 + i * lh + 20,
          size,
          color: C("green"),
          anchor: "middle",
          t0: tz + 0.1 + i * 0.1,
          dur: 0.35,
          g,
          anim: "fade",
          sketch: false,
        }),
      );
      const zw = Math.max(...lz.map((l) => textWidth(l, size)));
      R(
        gen.line(xz - zw / 2, cy + ((lz.length - 1) * lh) / 2 + 48, xz + zw / 2, cy + ((lz.length - 1) * lh) / 2 + 52, {
          seed: seed(),
          stroke: C("green"),
          strokeWidth: 5,
          roughness: 1.3,
        }),
        tz + 0.5,
        0.3,
      );
      break;
    }
    case "doodle": {
      const href = b.focus ? P.icon(b.focus) : undefined;
      const label = b.text.trim();
      const s = 340,
        iy = cy - s / 2 - (label ? 70 : 0);
      if (href) {
        R(gen.circle(cx, iy + s / 2, s + 90, { seed: seed(), stroke: C("orange"), strokeWidth: 4, roughness: 1.3 }), t0 + 0.05, 0.5);
        P.img({ href, x: cx - s / 2, y: iy, w: s, h: s, t0: t0 + 0.25, dur: 0.4, g, anim: "pop" });
      }
      if (label) {
        const ls = fitSize(label, href ? 76 : 120, 1500);
        const ly = href ? iy + s + 150 : cy + ls * 0.35;
        P.text({
          text: label,
          x: cx,
          y: ly,
          size: ls,
          color: th.ink,
          anchor: "middle",
          t0: t0 + (href ? 0.5 : 0.1),
          dur: 0.5,
          g,
          sketch: false,
        });
        R(
          gen.line(cx - textWidth(label, ls) / 2, ly + 22, cx + textWidth(label, ls) / 2, ly + 28, {
            seed: seed(),
            stroke: C("orange"),
            strokeWidth: 5,
            roughness: 1.4,
          }),
          t0 + (href ? 0.9 : 0.5),
          0.35,
        );
      }
      break;
    }
  }
  P.setOp(g, t1 + 0.05, 0, 0.01);
}

function rowsOf(toks: string[], size: number, maxW: number) {
  const rows: { idx: number[]; w: number }[] = [{ idx: [], w: 0 }];
  const sp = textWidth(" ", size);
  toks.forEach((t, i) => {
    const tw = textWidth(t, size),
      r = rows[rows.length - 1];
    if (r.idx.length && r.w + sp + tw > maxW) rows.push({ idx: [i], w: tw });
    else {
      r.w += (r.idx.length ? sp : 0) + tw;
      r.idx.push(i);
    }
  });
  return rows;
}
const FLAT =
  /^(the|and|of|a|an|to|in|on|for|at|is|it|its|by|with|you|your|does|do|how|why|what|when|that|this|from|into|just|can|will|be|are|was|has|have|own|one)$/;
function keyIndex(toks: string[]) {
  for (let i = toks.length - 1; i >= 0; i--) {
    const w = norm(toks[i]);
    if (w.length >= 4 && !FLAT.test(w)) return i;
  }
  return toks.length - 1;
}

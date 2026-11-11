import { parseFigure, parseDated, type NoteItem } from "@explanimate/core";
import { countries, findPlace, MAP_CREDIT, type Place } from "@explanimate/core/places";
import { wrapText, type Box } from "./layout.js";
import { textWidth } from "./measure.js";

/**
 * News-explainer cut-ins drawn on the whiteboard: a bar chart of figures the source states, and a timeline of
 * its dates. Positions are relative to the panel's top-left so the region grid can place the panel anywhere.
 */

export const CHART = { row: 136, bar: 72, size: 50, maxBar: 1000, gap: 34 };
export interface Bar {
  item: number;
  label: string;
  shown: string;
  label_x: number;
  bar: Box;
  value_x: number;
  text_y: number;
}

/** Bars share one scale starting at zero, longest = maxBar, so their lengths compare honestly. */
export function chartLayout(items: NoteItem[]): { w: number; h: number; bars: Bar[] } {
  const figs = items.map((it) => parseFigure(it.text)!);
  const labelW = Math.max(...figs.map((f) => textWidth(f.label, CHART.size)));
  const top = Math.max(...figs.map((f) => f.value)) || 1;
  const x0 = labelW + CHART.gap;
  const bars = figs.map((f, i) => {
    const y = i * CHART.row;
    const w = Math.max(14, (f.value / top) * CHART.maxBar);
    return {
      item: i,
      label: f.label,
      shown: f.shown,
      label_x: 0,
      bar: { x: x0, y: y + (CHART.row - CHART.bar) / 2, w, h: CHART.bar },
      value_x: x0 + w + 24,
      text_y: y + CHART.row / 2 + CHART.size * 0.35,
    };
  });
  const valueW = Math.max(...figs.map((f) => textWidth(f.shown, CHART.size)));
  return { w: x0 + CHART.maxBar + 24 + valueW, h: figs.length * CHART.row, bars };
}

export const TIMELINE = { step: 440, date: 52, label: 40, labelW: 400, lineY: 110 };
export interface Tick {
  item: number;
  x: number;
  when: string;
  lines: string[];
}

/** Evenly spaced ticks in date order: the date above the line, what happened below it. */
export function timelineLayout(items: NoteItem[]): { w: number; h: number; lineY: number; ticks: Tick[] } {
  const rows = items.map((it, i) => ({ i, d: parseDated(it.text)! })).sort((a, b) => a.d.key - b.d.key);
  const pad = TIMELINE.labelW / 2;
  const ticks = rows.map((r, k) => ({
    item: r.i,
    x: pad + k * TIMELINE.step,
    when: r.d.when,
    lines: wrapText(r.d.label, TIMELINE.label, TIMELINE.labelW, 2),
  }));
  const deepest = Math.max(...ticks.map((t) => t.lines.length));
  return {
    w: pad * 2 + (rows.length - 1) * TIMELINE.step,
    h: TIMELINE.lineY + 70 + deepest * TIMELINE.label * 1.25,
    lineY: TIMELINE.lineY,
    ticks,
  };
}

export type CutInKind = "chart" | "timeline" | "map";
export const cutInSize = (kind: CutInKind, items: NoteItem[]) =>
  kind === "map" ? { w: MAP.w, h: MAP.h } : (({ w, h }) => ({ w, h }))(kind === "chart" ? chartLayout(items) : timelineLayout(items));
/** The map card for a scene, from the bundled Natural Earth data. */
export const sceneMap = (items: NoteItem[]) => mapLayout(items, countries(), findPlace);

export const MAP = { w: 1800, h: 1012, label: 46, dot: 15, credit: 28, pad: 0.35 };
export interface MapPin {
  item: number;
  kind: "country" | "city";
  iso: string;
  x: number;
  y: number;
  label: string;
  lx: number;
  ly: number;
  anchor: "start" | "middle";
  /** a thin line from the pin to a label set away from it, so it is clear whose label it is */ lead?: [number, number];
}
export interface MapLayout {
  w: number;
  h: number;
  land: { iso: string; rings: [number, number][][] }[];
  pins: MapPin[];
  credit: { x: number; y: number };
}

/** Clip a ring to the panel (Sutherland-Hodgman against each edge), so no coastline spills past the card. */
function clipRing(r: [number, number][], w: number, h: number): [number, number][] {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= w, (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= h, (a, b) => [a[0] + ((b[0] - a[0]) * (h - a[1])) / (b[1] - a[1]), h]],
  ];
  let out = r;
  for (const [inside, cross] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length],
        b = src[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cross(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cross(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * A map card: the places the plan names, framed with room around them, real coastlines from Natural Earth,
 * named countries shaded and cities pinned, each label set where it does not cover another.
 */
export function mapLayout(
  items: NoteItem[],
  countries: { iso: string; rings: [number, number][][] }[],
  find: (name: string) => Place | undefined,
): MapLayout {
  const places = items.map((it) => find(it.target)!);
  let x0 = 180,
    y0 = 90,
    x1 = -180,
    y1 = -90;
  for (const p of places) {
    const [a, b, c, d] = p.kind === "country" ? p.bbox : [p.lon, p.lat, p.lon, p.lat];
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  const midLat = (y0 + y1) / 2,
    k = Math.cos((Math.max(-70, Math.min(70, midLat)) * Math.PI) / 180);
  // a projected width and height in degrees of longitude, padded and grown to the card's shape
  let pw = Math.max((x1 - x0) * k * (1 + 2 * MAP.pad), 16),
    ph = Math.max((y1 - y0) * (1 + 2 * MAP.pad), 9);
  if (pw / ph > MAP.w / MAP.h) ph = (pw * MAP.h) / MAP.w;
  else pw = (ph * MAP.w) / MAP.h;
  const cx = ((x0 + x1) / 2) * k,
    cy = (y0 + y1) / 2,
    s = MAP.w / pw;
  const P = ([lon, lat]: [number, number]): [number, number] => [(lon * k - cx) * s + MAP.w / 2, (cy - lat) * s + MAP.h / 2];
  const land = countries.flatMap((c) => {
    const rings = c.rings
      .map((r) => clipRing(r.map(P), MAP.w, MAP.h))
      .filter((r) => {
        if (r.length < 3) return false;
        const xs = r.map((p) => p[0]),
          ys = r.map((p) => p[1]);
        return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) > 12;
      });
    return rings.length ? [{ iso: c.iso, rings }] : [];
  });
  // labels: right of the pin, then left, above, below; the first spot that stays on the card and clear of the others
  const taken: Box[] = [];
  const pins = places
    .map((p, i) => {
      const [x, y] = P([p.lon, p.lat]);
      taken.push({ x: x - MAP.dot, y: y - MAP.dot, w: MAP.dot * 2, h: MAP.dot * 2 });
      return { p, i, x, y };
    })
    .map(({ p, i, x, y }) => {
      const label = items[i].text,
        tw = textWidth(label, MAP.label) + 20,
        th = MAP.label * 1.3,
        g = 24;
      const spots: [number, number, MapPin["anchor"]][] =
        p.kind === "country"
          ? [
              [x, y + MAP.label * 0.35, "middle"],
              [x, y - th, "middle"],
              [x, y + th + 10, "middle"],
            ]
          : [0, -1, 1, -2, 2]
              .flatMap((row): [number, number, MapPin["anchor"]][] => {
                // beside the pin first, then stepped a line up or down, then above and below it
                const ly = y + MAP.label * 0.35 + row * th;
                return [
                  [x + g, ly, "start"],
                  [x - g - textWidth(label, MAP.label), ly, "start"],
                ];
              })
              .concat([
                [x, y - g - 6, "middle"],
                [x, y + g + th - 6, "middle"],
              ]);
      const boxOfSpot = ([lx, ly, a]: [number, number, MapPin["anchor"]]): Box => ({
        x: a === "start" ? lx - 10 : lx - tw / 2,
        y: ly - MAP.label * 0.95,
        w: tw,
        h: th,
      });
      const fits = (b: Box) => b.x >= 10 && b.y >= 10 && b.x + b.w <= MAP.w - 10 && b.y + b.h <= MAP.h - MAP.credit * 2;
      const clear = (b: Box) => taken.every((o) => b.x >= o.x + o.w || o.x >= b.x + b.w || b.y >= o.y + o.h || o.y >= b.y + b.h);
      const pick = spots.find((sp) => fits(boxOfSpot(sp)) && clear(boxOfSpot(sp))) ?? spots.find((sp) => fits(boxOfSpot(sp))) ?? spots[0];
      const b = boxOfSpot(pick);
      taken.push(b);
      const near: [number, number] = [Math.max(b.x, Math.min(x, b.x + b.w)), Math.max(b.y, Math.min(y, b.y + b.h))];
      const lead = p.kind === "city" && Math.hypot(near[0] - x, near[1] - y) > g + 12 ? near : undefined;
      return { item: i, kind: p.kind, iso: p.iso, x, y, label, lx: pick[0], ly: pick[1], anchor: pick[2], lead };
    });
  return { w: MAP.w, h: MAP.h, land, pins, credit: { x: MAP.w - 20 - textWidth(MAP_CREDIT, MAP.credit), y: MAP.h - 18 } };
}

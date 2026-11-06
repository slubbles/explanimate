import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getTheme, specFromBrief, DEFAULT_BRIEF } from "@explanimate/core";
import { compose, loadIconPack, captureFrames, cameraAt, textWidth, cardSlots, saidAt, CARD } from "../src/index.js";
import { captureFramesSkia } from "../src/skia.js";

const fx = new URL("./fixtures/", import.meta.url);
const base = JSON.parse(fs.readFileSync(new URL("clipfeed.plan.json", fx), "utf8"));
const arch = JSON.parse(fs.readFileSync(new URL("clipfeed.architecture.json", fx), "utf8"));
const audio = base.scenes.map((s: any) => {
  const ws = s.narration.split(/\s+/);
  return {
    sceneId: s.id,
    duration: ws.length * 0.38,
    words: ws.map((w: string, i: number) => ({ word: w, start: i * 0.38, end: i * 0.38 + 0.3 })),
  };
});
const lines = (n: string) => n.split(/(?<=[.!?])\s+/);
const beat = (line: string, visual: string, o: { text?: string; items?: string[]; focus?: string } = {}) => ({
  line,
  visual,
  anchor: line.split(/\s+/).slice(0, 2).join(" "),
  text: o.text ?? "",
  items: o.items ?? [],
  focus: o.focus ?? "",
});
// every card type once, on lines of the fixture's own narration
const plan = structuredClone(base);
const sc = (id: string) => plan.scenes.find((s: any) => s.id === id);
const L = (id: string) => lines(sc(id).narration);
sc("s01-hook").beats = [
  beat(L("s01-hook")[0], "kinetic", { text: "Clipfeed is a Bisaya meme music TikTok feed" }),
  beat(L("s01-hook")[1], "board"),
];
sc("s02-notes").beats = [
  beat(L("s02-notes")[0], "chips", { text: "it must", items: ["video feed", "clips", "live chat"] }),
  beat(L("s02-notes")[1], "kinetic", { text: "fast global video start" }),
];
sc("s03-layer").beats = [
  beat(L("s03-layer")[0], "board"),
  beat(L("s03-layer")[1], "browser", {
    text: "clipfeed.com/admin",
    items: ["email box", "password box", "button log in"],
    focus: "button log in",
  }),
  beat(L("s03-layer")[2], "terminal", { text: "npx wrangler deploy" }),
];
sc("s04-layer").beats = [
  beat(L("s04-layer")[0], "number", { text: "eighty one route handlers" }),
  beat(L("s04-layer")[1], "board"),
  beat(L("s04-layer")[2], "output", { text: "clip blobs", items: ["clip-01.mp4", "clip-01.jpg", "clip-02.mp4"], focus: "clip-01.mp4" }),
];
sc("s05-layer").beats = [
  beat(L("s05-layer")[0], "board"),
  beat(L("s05-layer")[1], "doodle", { text: "live chat", focus: "chat" }),
  beat(L("s05-layer")[2], "contrast", { items: ["tallies hearts", "blocks floods"] }),
];
sc("s08-notes").beats = [beat(L("s08-notes")[0], "board"), beat(L("s08-notes")[1], "number", { text: "10 times at peak" })];
const spec = specFromBrief(DEFAULT_BRIEF),
  pack = loadIconPack();

test("a card holds its line: from its anchor to the next line, 2 to 4.5 s, never before the title card", () => {
  const ws = "one two three four. five six seven eight nine.".split(" ").map((w, i) => ({ word: w, start: i * 0.7, end: i * 0.7 + 0.4 }));
  const b = [
    beat("one two three four.", "kinetic", { text: "one two three four" }),
    beat("five six seven eight nine.", "terminal", { text: "ls" }),
  ];
  const s = cardSlots("x", b as any, ws, 0, 10);
  assert.equal(s.length, 2);
  assert.equal(s[0].t0, 0);
  // back-to-back card lines cut straight from one card to the next
  assert.equal(s[0].t1, s[1].t0);
  assert.ok(Math.abs(s[1].t0 - 2.68) < 1e-9 && s[1].t1 <= 10 && s[1].t1 - s[1].t0 <= CARD.max);
  const late = cardSlots("x", b as any, ws, 1.5, 10);
  assert.deepEqual(
    late.map((x) => x.beat.visual),
    ["terminal"],
    "a line said before cards may cut in is left to the board",
  );
  assert.equal(cardSlots("x", [beat("ten eleven.", "kinetic")] as any, ws, 0, 10).length, 0, "a line the voice never says gets no card");
});

test("no card flashes by: every slot holds at least two seconds, even when its lines come fast", () => {
  const ws = "one two three four. five six seven eight.".split(" ").map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.3 }));
  const b = [
    beat("one two three four.", "kinetic", { text: "one two three four" }),
    beat("five six seven eight.", "terminal", { text: "ls" }),
  ];
  const s = cardSlots("x", b as any, ws, 0, 10);
  assert.ok(s.length >= 1, "at least the opening card survives");
  for (const c of s) assert.ok(c.t1 - c.t0 >= 2.0 - 1e-9, `card holds ${c.t1 - c.t0}s, under two seconds`);
});

test("line cards cut in over the board and back, keep clear of the heading, and fit their frame", async () => {
  const theme = getTheme("pen-light");
  const plain = await compose({ plan: base, audio, theme, spec, pack, sourceLabel: "x", arch });
  const out = await compose({ plan, audio, theme, spec, pack, sourceLabel: "x", arch });
  const cards = out.cards!;
  assert.deepEqual([...new Set(cards.map((c) => c.visual))].sort(), [
    "browser",
    "chips",
    "contrast",
    "doodle",
    "kinetic",
    "number",
    "output",
    "terminal",
  ]);
  const film = out.film;
  for (const [i, c] of cards.entries()) {
    const cam = cameraAt(film, (c.t0 + c.t1) / 2);
    assert.ok(Math.abs(cam.y - (CARD.top + i * CARD.gapY)) < 1 && Math.abs(cam.w - 1920) < 1, `card ${i} is framed whole`);
    assert.ok(!film.headings.some((h) => h.t0 < c.t1 - 0.01 && h.t1 > c.t0 + 0.01), `no heading over card ${i}`);
    const pre = cameraAt(plain.film, c.t1 + 0.01),
      post = cameraAt(film, c.t1 + 0.01);
    const chained = cards[i + 1] && cards[i + 1].t0 - c.t1 < 0.05;
    if (!chained)
      assert.ok(
        Math.abs(pre.x - post.x) < pre.w * 0.01 && Math.abs(pre.w - post.w) < pre.w * 0.01,
        `card ${i} returns to the board shot it left`,
      );
    assert.ok(
      !film.elements.some((e) => e.g !== `card:${i}` && !e.g?.startsWith("card:") && e.t0 > c.t0 && e.t0 < c.t1),
      `nothing on the board is drawn under card ${i}`,
    );
    for (const e of film.elements.filter((e) => e.g === `card:${i}`)) {
      assert.ok(e.t0 >= c.t0 - 0.01 && e.t0 + e.dur <= c.t1 + 0.6, `card ${i} ${e.k} drawn while the card is up`);
      if (e.k !== "text") continue;
      const w = textWidth(e.text, e.size),
        x0 = e.anchor === "middle" ? e.x - w / 2 : e.x;
      assert.ok(x0 >= 110 && x0 + w <= 1920 - 110, `card ${i} "${e.text}" fits across`);
      assert.ok(e.y - e.size >= cam.y + 60 && e.y <= cam.y + 1080 - 180, `card ${i} "${e.text}" clear of the captions`);
    }
  }
  // the board itself is untouched: the same boxes and the same exports
  assert.deepEqual(
    out.sketch.nodes.map((n) => n.id),
    plain.sketch.nodes.map((n) => n.id),
  );
  assert.equal(out.sketch.texts.length, plain.sketch.texts.length);
});

test("the opening is the title card alone: no icon row under it", async () => {
  const { film } = await compose({ plan: base, audio, theme: getTheme("pen-light"), spec, pack, sourceLabel: "x", arch });
  assert.equal(film.elements.filter((e) => e.g === "hook" && e.k === "img").length, 0);
});

const ssim = (a: string[], b: string[]) =>
  Number(
    /All:([\d.]+)/.exec(
      spawnSync("ffmpeg", ["-v", "info", ...a, ...b, "-lavfi", "ssim", "-f", "null", "-"], { encoding: "utf8" }).stderr,
    )?.[1] ?? 0,
  );

test("skia draws every card the way chrome does", { timeout: 240_000 }, async () => {
  for (const theme of ["pen-light", "chalk-dark"]) {
    const out = await compose({ plan, audio, theme: getTheme(theme), spec, pack, sourceLabel: "x", arch });
    const film = out.film;
    const only = out.cards!.map((c) => Math.round(Math.min(c.t1 - 0.25, c.t0 + 1.6) * film.fps));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explanimate-cards-"));
    await captureFrames(film, path.join(dir, "c"), { only, workers: 2 });
    const raw = new Map<number, Buffer>();
    await captureFramesSkia(film, path.join(dir, "s"), {
      only,
      workers: 2,
      onFrame: (f, b) => {
        raw.set(f, Buffer.from(b));
      },
    });
    for (const f of only) {
      const id = String(f).padStart(6, "0"),
        file = path.join(dir, `s${id}.rgba`);
      fs.writeFileSync(file, raw.get(f)!);
      const s = ssim(
        ["-i", path.join(dir, "c", `f${id}.jpg`)],
        ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${film.width}x${film.height}`, "-i", file],
      );
      assert.ok(s > 0.97, `${theme} frame ${f} (${(f / film.fps).toFixed(1)}s): ssim ${s}`);
    }
    if (process.env.KEEP_CARD_FRAMES) fs.cpSync(dir, path.join(process.env.KEEP_CARD_FRAMES, theme), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saidAt matches hyphenated names however the voice split them", () => {
  const w = (word: string, start: number) => ({ word, start, end: start + 0.2 });
  const one = [w("The", 0), w("agent-browser", 0.3), w("CLI,", 0.8), w("runs", 1)];
  const two = [w("The", 0), w("agent", 0.3), w("browser", 0.5), w("CLI", 0.8)];
  assert.equal(saidAt(one, "agent-browser CLI"), 1);
  assert.equal(saidAt(two, "agent-browser CLI"), 1);
  assert.equal(saidAt(one, "The agent-browser CLI,"), 0);
  assert.equal(saidAt(one, "agent-browser", 2), -1);
});

test("a kinetic row stays centred while it builds: each stage is laid out on the words said so far and leaves as the next word lands", async () => {
  const { buildRow } = await import("../src/cards.js");
  const els: any[] = [],
    ops: Record<string, [number, number][]> = {};
  const P: any = {
    text: (o: any) => els.push({ ...o }),
    setOp: (g: string, t: number, v: number) => (ops[g] ??= []).push([t, v]),
    rough: () => {},
    cueNext: () => {},
  };
  const words = ["agents", "click", "real", "pages"].map((text, i) => ({ text, t: i * 0.5, color: "#000" }));
  const lines: number[] = [];
  const groups = buildRow(P, {
    words,
    cx: 960,
    y: 500,
    size: 100,
    g: "card:0/r0",
    key: 2,
    underline: (_a, _b, _t, dur) => lines.push(dur),
  });
  assert.deepEqual(groups, ["card:0/r0/s1", "card:0/r0/s2", "card:0/r0/s3", "card:0/r0/s4"]);
  for (const g of groups) {
    const row = els.filter((e) => e.g === g);
    const left = row[0].x,
      right = row[row.length - 1].x + textWidth(row[row.length - 1].text, 100);
    assert.ok(Math.abs((left + right) / 2 - 960) < 1, `${g} is centred`);
  }
  assert.deepEqual(Object.keys(ops), groups.slice(0, 3), "every stage but the last leaves");
  assert.deepEqual(
    groups.slice(0, 3).map((g) => ops[g][0][0]),
    [0.5, 1, 1.5],
  );
  assert.ok(lines[0] > 0.1 && lines[1] < 0.05, "the underline draws once, then is already there");
});

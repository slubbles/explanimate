// Explanimate stage drawn with Skia (@napi-rs/canvas) instead of a headless Chrome page.
// It draws the same picture as stage/stage.js, frame for frame. Text and HUD positions come from a
// one-off Chrome layout probe (see skia.ts), so words, captions and headings land on the same pixels.
// Plain JS on purpose: worker threads load it without a TypeScript loader.

/** Same as reveal.ts wordOpacities (a test keeps the two in step). */
export function wordOpacities(n, p) {
  const f = Math.min(1, Math.max(0.35, 1.5 / Math.max(1, n)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = n > 1 ? ((1 - f) * i) / (n - 1) : 0;
    out.push(Math.min(1, Math.max(0, (p - s) / f)));
  }
  return out;
}
/** Same as reveal.ts revealWords. */
export function revealWords(text) {
  return text.match(/\S+\s*/g) ?? [text];
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const back = (p) => {
  const c1 = 1.70158,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

function interp(keys, t, dflt) {
  if (!keys || !keys.length) return dflt;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i][0]) {
      const [t0, v0] = keys[i - 1],
        [t1, v1] = keys[i];
      return v0 + (v1 - v0) * ((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

/** "#rgb" / "#rrggbb" with an alpha, for gradients that fade a colour to clear (CSS "transparent" does the same). */
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return `rgba(0,0,0,${a})`;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

/** Length of an SVG path (M L H V C S Q T Z, absolute or relative), the way getTotalLength measures it. */
export function pathLength(d) {
  const tok = d.match(/[MLHVCSQTZmlhvcsqtz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0,
    cmd = "",
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    L = 0,
    cx = 0,
    cy = 0;
  const n = () => Number(tok[i++]);
  const bez = (p) => {
    let len = 0,
      px = p[0][0],
      py = p[0][1];
    const N = 48;
    for (let s = 1; s <= N; s++) {
      const t = s / N,
        u = 1 - t;
      let qx, qy;
      if (p.length === 4) {
        qx = u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0];
        qy = u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1];
      } else {
        qx = u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0];
        qy = u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1];
      }
      len += Math.hypot(qx - px, qy - py);
      px = qx;
      py = qy;
    }
    return len;
  };
  while (i < tok.length) {
    if (/^[a-z]$/i.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(),
      C = cmd.toUpperCase(),
      ox = rel ? x : 0,
      oy = rel ? y : 0;
    if (C === "M") {
      x = sx = n() + ox;
      y = sy = n() + oy;
      cx = x;
      cy = y;
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      const nx = n() + ox,
        ny = n() + oy;
      L += Math.hypot(nx - x, ny - y);
      x = cx = nx;
      y = cy = ny;
    } else if (C === "H") {
      const nx = n() + ox;
      L += Math.abs(nx - x);
      x = cx = nx;
    } else if (C === "V") {
      const ny = n() + oy;
      L += Math.abs(ny - y);
      y = cy = ny;
    } else if (C === "C" || C === "S") {
      const c1 = C === "C" ? [n() + ox, n() + oy] : [2 * x - cx, 2 * y - cy],
        c2 = [n() + ox, n() + oy],
        e = [n() + ox, n() + oy];
      L += bez([[x, y], c1, c2, e]);
      cx = c2[0];
      cy = c2[1];
      [x, y] = e;
    } else if (C === "Q" || C === "T") {
      const c1 = C === "Q" ? [n() + ox, n() + oy] : [2 * x - cx, 2 * y - cy],
        e = [n() + ox, n() + oy];
      L += bez([[x, y], c1, e]);
      cx = c1[0];
      cy = c1[1];
      [x, y] = e;
    } else if (C === "Z") {
      L += Math.hypot(sx - x, sy - y);
      x = cx = sx;
      y = cy = sy;
    } else i++;
  }
  return L;
}

/**
 * Build a stage for one film. `layout` is the Chrome probe (skia.ts); `lib` is @napi-rs/canvas.
 * Returns render(t), which draws frame time t into `canvas`.
 */
export async function makeSkiaStage(F, layout, lib, fam = { hand: "Excalifont", sans: "ExplainSans" }) {
  const { createCanvas, Path2D, loadImage, StrokeCap, StrokeJoin } = lib;
  const W = F.width,
    H = F.height,
    T = F.theme;
  const cv = createCanvas(W, H),
    g = cv.getContext("2d");
  let endCv = null;

  const fontOf = (size, family, weight = 400) => `${weight} ${size}px ${family}`;
  const setFont = (ctx, size, family, weight = 400, spacing = "0px") => {
    ctx.font = fontOf(size, family, weight);
    // Nunito is a variable font: CSS picks the weight on its wght axis, so do the same here
    ctx.fontVariationSettings = family === fam.sans ? `"wght" ${weight}` : "normal";
    ctx.letterSpacing = spacing;
  };

  const items = [];
  for (let idx = 0; idx < F.elements.length; idx++) {
    const e = F.elements[idx],
      it = { e, idx };
    if (e.k === "path") {
      it.p = new Path2D(e.d);
      it.len = layout.pathLen?.[idx] ?? pathLength(e.d);
      if (e.outline) it.o = new Path2D(e.outline);
    } else if (e.k === "img") {
      let im = await loadImage(e.href);
      if (e.invert) {
        // CSS invert(1): flip the colour channels, keep alpha. Done once here instead of every frame.
        const c = createCanvas(im.width, im.height),
          x = c.getContext("2d");
        x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, im.width, im.height);
        for (let k = 0; k < d.data.length; k += 4) {
          d.data[k] = 255 - d.data[k];
          d.data[k + 1] = 255 - d.data[k + 1];
          d.data[k + 2] = 255 - d.data[k + 2];
        }
        x.putImageData(d, 0, 0);
        im = c;
      }
      it.im = im;
    } else if (e.k === "text") {
      it.words = revealWords(e.text);
      it.fam = e.font === "sans" ? fam.sans : fam.hand;
      it.probe = layout.text?.[idx] ?? null;
    } else if (e.k === "dot") {
      let L = 0;
      const acc = [0];
      for (let i = 1; i < e.pts.length; i++) {
        L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
        acc.push(L);
      }
      it.L = L;
      it.acc = acc;
      if (e.trail) {
        const tp = new Path2D();
        e.pts.forEach(([x, y], i) => (i ? tp.lineTo(x, y) : tp.moveTo(x, y)));
        it.tp = tp;
      }
    }
    items.push(it);
  }

  function pointAt(it, d) {
    const pts = it.e.pts,
      acc = it.acc;
    for (let i = 1; i < pts.length; i++) {
      if (d <= acc[i]) {
        const f = (d - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1]);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
    }
    return pts[pts.length - 1];
  }

  function camera(t) {
    const K = F.camera;
    let cur = K[0];
    for (let i = 1; i < K.length; i++) {
      const k = K[i];
      if (t < k.t) break;
      const p = k.move > 0 ? ease(clamp((t - k.t) / k.move, 0, 1)) : 1;
      const prev = cur;
      cur = {
        x: prev.x + (k.x - prev.x) * p,
        y: prev.y + (k.y - prev.y) * p,
        w: prev.w + (k.w - prev.w) * p,
        h: prev.h + (k.h - prev.h) * p,
      };
    }
    return cur;
  }

  // world-space text: word start positions from Chrome's SVG layout when probed, else measured here
  function textRun(it, words) {
    const e = it.e;
    setFont(g, e.size, it.fam, e.weight ?? 400);
    const wd = words.map((w) => g.measureText(w).width),
      tw = wd.reduce((a, b) => a + b, 0);
    let x = e.anchor === "middle" ? e.x - tw / 2 : e.anchor === "end" ? e.x - tw : e.x;
    const xs = wd.map((w) => {
      const at = x;
      x += w;
      return at;
    });
    return { xs, tw };
  }

  function drawWorld(t) {
    const cam = camera(t);
    // SVG viewBox with the default preserveAspectRatio (xMidYMid meet)
    const s = Math.min(W / cam.w, H / cam.h),
      ox = (W - cam.w * s) / 2 - cam.x * s,
      oy = (H - cam.h * s) / 2 - cam.y * s;
    for (const it of items) {
      const e = it.e;
      if (t < e.t0) continue;
      const op = e.g ? interp(F.groups[e.g], t, 1) : 1;
      if (op <= 0.001) continue;
      const p = clamp((t - e.t0) / Math.max(0.001, e.dur), 0, 1);
      let o = op;
      g.setTransform(s, 0, 0, s, ox, oy);
      if (e.k === "path") {
        const a = e.anim || "draw";
        if (a === "pop") {
          const k = 0.4 + 0.6 * back(p),
            [px, py] = e.origin || [0, 0];
          g.translate(px, py);
          g.scale(k, k);
          g.translate(-px, -py);
          o *= clamp(p * 3, 0, 1);
        } else if (a === "fade") o *= p;
        g.globalAlpha = clamp(o, 0, 1);
        const shown = a === "draw" ? easeOut(p) : 1;
        if (it.o) {
          if (e.fill) {
            g.fillStyle = e.fill;
            g.fill(it.p);
          }
          g.fillStyle = e.stroke;
          if (shown < 1) {
            // stage.js reveals the marker outline through a mask: the centre line, 3x wide, dashed to the drawn length
            const L = it.len;
            const m = new Path2D(it.p)
              .dash(Math.max(1e-3, L * shown), L, 0)
              .stroke({ width: e.sw * 3, cap: StrokeCap.Round, join: StrokeJoin.Round });
            g.save();
            g.clip(m);
            g.fill(it.o);
            g.restore();
          } else g.fill(it.o);
        } else {
          if (e.fill) {
            g.fillStyle = e.fill;
            g.fill(it.p);
          }
          g.strokeStyle = e.stroke;
          g.lineWidth = e.sw;
          g.lineCap = "round";
          g.lineJoin = "round";
          if (shown < 1) {
            g.setLineDash([it.len, it.len]);
            g.lineDashOffset = it.len * (1 - shown);
          }
          g.stroke(it.p);
          if (shown < 1) {
            g.setLineDash([]);
            g.lineDashOffset = 0;
          }
        }
      } else if (e.k === "img") {
        if ((e.anim || "pop") === "pop") {
          const k = 0.5 + 0.5 * back(p),
            cx = e.x + e.w / 2,
            cy = e.y + e.h / 2;
          g.translate(cx, cy);
          g.scale(k, k);
          g.translate(-cx, -cy);
          o *= clamp(p * 2.5, 0, 1);
        } else o *= p;
        g.globalAlpha = clamp(o, 0, 1);
        const im = it.im,
          r = Math.min(e.w / im.width, e.h / im.height),
          dw = im.width * r,
          dh = im.height * r;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        g.drawImage(im, e.x + (e.w - dw) / 2, e.y + (e.h - dh) / 2, dw, dh);
      } else if (e.k === "text") {
        const anim = e.anim || "wipe";
        let words = it.words,
          xs,
          bb = it.probe?.bb,
          wordOps = null,
          bgOp = 1;
        if (anim === "count" && e.count) {
          const n = Math.round(e.count.from + (e.count.to - e.count.from) * easeOut(p));
          words = [`${n}${e.count.suffix}`];
          xs = textRun(it, words).xs;
          const k = 0.5 + 0.5 * back(clamp(p * 1.6, 0, 1));
          g.translate(e.x, e.y);
          g.scale(k, k);
          g.translate(-e.x, -e.y);
          if (bb && !e.bgBox) {
            const w = (bb.w * (String(n).length + e.count.suffix.length)) / Math.max(1, e.text.length);
            bb = { ...bb, x: e.x - w / 2 - 12 + 8, w: w + 24 - 16 };
          }
          o *= clamp(p * 4, 0, 1);
        } else {
          xs = it.probe?.xs ?? textRun(it, words).xs;
          if (anim === "wipe") {
            wordOps = wordOpacities(words.length, easeOut(p));
            bgOp = clamp(p * 4, 0, 1);
          } else o *= p;
        }
        if (e.bg) {
          const r = e.bgBox ?? (bb ? { x: bb.x - 8, y: bb.y - 2, w: bb.w + 16, h: bb.h + 4 } : null);
          if (r) {
            g.globalAlpha = clamp(o * bgOp, 0, 1);
            g.fillStyle = e.bg;
            g.beginPath();
            g.roundRect(r.x, r.y, r.w, r.h, 6);
            g.fill();
          }
        }
        setFont(g, e.size, it.fam, e.weight ?? 400);
        g.textAlign = "left";
        g.textBaseline = "alphabetic";
        g.fillStyle = e.color;
        const y = it.probe?.y ?? e.y;
        for (let i = 0; i < words.length; i++) {
          const a = o * (wordOps ? wordOps[i] : 1);
          if (a <= 0) continue;
          g.globalAlpha = clamp(a, 0, 1);
          g.fillText(words[i], xs[i], y);
        }
      } else if (e.k === "dot") {
        const d = it.L * ease(p);
        if (it.tp) {
          g.globalAlpha = clamp(o * 0.9, 0, 1);
          g.strokeStyle = e.trail;
          g.lineWidth = 7;
          g.lineCap = "round";
          g.lineJoin = "round";
          g.setLineDash([it.L, it.L]);
          g.lineDashOffset = it.L - d;
          g.stroke(it.tp);
          g.setLineDash([]);
          g.lineDashOffset = 0;
        }
        if (p < 1) {
          const [x, y] = pointAt(it, d);
          g.fillStyle = e.color;
          g.globalAlpha = clamp(o * 0.25, 0, 1);
          g.beginPath();
          g.arc(x, y, e.r * 2.2, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = clamp(o, 0, 1);
          g.beginPath();
          g.arc(x, y, e.r, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
  }

  // ---------- HUD, in screen pixels, in the stage's DOM order ----------
  const HIN = 0.55,
    HOUT = 0.45;
  const LH = layout.head;

  function drawHead(h, inP, outP, lineP) {
    const base = 1 - outP;
    if (base <= 0) return;
    const dy = -30 * easeOut(outP);
    setFont(g, 64, fam.hand);
    g.fillStyle = T.ink;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    const ws = revealWords(h.text),
      ops = wordOpacities(ws.length, easeOut(inP));
    let x = LH.x;
    for (let i = 0; i < ws.length; i++) {
      const w = g.measureText(ws[i]).width;
      if (ops[i] > 0) {
        g.globalAlpha = clamp(base * ops[i], 0, 1);
        g.fillText(ws[i], x, LH.base + dy);
      }
      x += w;
    }
    const sx = easeOut(lineP);
    if (sx > 0) {
      g.globalAlpha = clamp(base, 0, 1);
      g.fillStyle = T.accent;
      g.save();
      g.translate(LH.x, LH.lineTop + dy);
      g.scale(sx, 1);
      g.beginPath();
      g.roundRect(0, 0, x - LH.x, LH.lineH, 4);
      g.fill();
      g.restore();
    }
  }

  function drawHud(t) {
    g.globalAlpha = 1;
    // #topband: linear-gradient(background 62%, transparent) over the top 200px
    const grad = g.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, T.background);
    grad.addColorStop(0.62, T.background);
    grad.addColorStop(1, withAlpha(T.background, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, 200);

    const i = F.headings.findIndex((x) => t >= x.t0 && t < x.t1);
    const h = F.headings[i],
      prev = i > 0 ? F.headings[i - 1] : null,
      next = h && F.headings[i + 1];
    if (h) {
      const same = prev && prev.text === h.text && h.t0 - prev.t1 < 0.2;
      const chained = prev && h.t0 - prev.t1 < 0.2;
      const k = t - h.t0;
      const outP = next && next.t0 - h.t1 < 0.2 ? 0 : clamp(1 - (h.t1 - t) / HOUT, 0, 1);
      const wait = chained && !same ? HOUT : 0;
      drawHead(h, same ? 1 : clamp((k - wait) / HIN, 0, 1), outP, same ? 1 : clamp((k - wait - 0.15) / 0.5, 0, 1));
      if (wait && k < HOUT) drawHead(prev, 1, clamp(k / HOUT, 0, 1), 1);
    }

    // #brand
    const B = layout.brand;
    setFont(g, 26, fam.sans, 800, "0.5px");
    g.globalAlpha = 0.42;
    g.fillStyle = T.ink;
    g.textAlign = "left";
    g.fillText(F.brand, B.x, B.base);
    g.letterSpacing = "0px";

    // #captions: one line, fixed at the bottom, Netflix style
    const ci = F.captions.findIndex((x) => !x.hidden && t >= x.t0 && t < x.t1);
    const C = ci >= 0 ? layout.caps[ci] : null;
    if (C) {
      const c = F.captions[ci];
      const a = clamp((t - c.t0) / 0.12, 0, 1),
        dy = 8 * (1 - easeOut(clamp((t - c.t0) / 0.15, 0, 1)));
      g.globalAlpha = a;
      g.fillStyle = T.caption.background;
      g.beginPath();
      g.roundRect(C.x, C.y + dy, C.w, C.h, 14);
      g.fill();
      setFont(g, 48, fam.sans, 800, "0.2px");
      for (let j = 0; j < c.words.length; j++) {
        const w = c.words[j],
          on = t >= w.s && t < (c.words[j + 1] ? c.words[j + 1].s : w.e + 0.3);
        g.globalAlpha = a * (on || t >= w.s ? 1 : 0.86);
        g.fillStyle = on ? T.caption.highlight : T.caption.color;
        g.fillText(w.w, C.xs[j], C.base + dy);
      }
      g.letterSpacing = "0px";
    }

    // #fade: the scene-change wash
    let fo = 0;
    for (const f of F.fades) {
      const d = Math.abs(t - f.t);
      if (d < f.dur) fo = Math.max(fo, 1 - d / f.dur);
    }
    if (fo > 0) {
      g.globalAlpha = fo;
      g.fillStyle = T.background;
      g.fillRect(0, 0, W, H);
    }

    // #end: drawn whole, then faded in as one layer like the CSS opacity
    if (F.end && t >= F.end.t0 && layout.end) {
      const p = clamp((t - F.end.t0) / 0.6, 0, 1);
      if (p >= 1) {
        g.globalAlpha = 1;
        drawEnd(g, 0);
      } else if (p > 0) {
        endCv ??= createCanvas(W, H);
        const x = endCv.getContext("2d");
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.clearRect(0, 0, W, H);
        drawEnd(x, (1 - easeOut(p)) * 30);
        g.globalAlpha = p;
        g.drawImage(endCv, 0, 0);
      }
    }

    // #barwrap / #bar: progress along the bottom edge, on top of everything
    g.globalAlpha = 1;
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(0, H - 8, W, 8);
    g.fillStyle = T.accent;
    g.fillRect(0, H - 8, W * clamp(t / F.duration, 0, 1), 8);
  }

  function drawEnd(x, titleDy) {
    const E = layout.end;
    x.globalAlpha = 1;
    x.fillStyle = T.background;
    x.fillRect(0, 0, W, H);
    x.textAlign = "left";
    x.textBaseline = "alphabetic";
    setFont(x, 96, fam.hand);
    x.fillStyle = T.ink;
    for (const w of E.title) x.fillText(w.w, w.x, w.y + titleDy);
    setFont(x, 34, fam.sans, 700);
    x.fillStyle = "#b9b9b9";
    for (const w of E.lines) x.fillText(w.w, w.x, w.y);
    const c = E.credit;
    if (c) {
      x.fillStyle = T.accent;
      x.beginPath();
      x.roundRect(c.x, c.y, c.w, c.h, Math.min(c.h, c.w) / 2);
      x.fill();
      setFont(x, 30, fam.sans, 800);
      x.fillStyle = "#fff";
      for (const w of c.words) x.fillText(w.w, w.x, w.y);
    }
  }

  return {
    canvas: cv,
    render(t) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.fillStyle = T.background;
      g.fillRect(0, 0, W, H);
      drawWorld(t);
      drawHud(t);
    },
  };
}

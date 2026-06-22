// Agent-first capture loop primitive: capture at 2x, verify regions (Layers 1-2), save only if pass.
// Usage: node capture-verify.mjs <cdp-ws-url> <out-path> '<spec-json>'
// spec = { width, height, regions:[{name,x,y,w,h,maxBgRatio,minVariance}], maxBlankRatio }
// Regions are in CSS px (this script multiplies by deviceScaleFactor=2 internally).

import fs from "node:fs";
import path from "node:path";

// Resolve sharp portably (normal resolve, else pnpm store under the repo root).
async function loadSharp() {
  try { return (await import("sharp")).default; } catch {}
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pnpm = path.join(dir, "node_modules", ".pnpm");
    if (fs.existsSync(pnpm)) {
      const match = fs.readdirSync(pnpm).find((d) => /^sharp@/.test(d));
      if (match) {
        const entry = path.join(pnpm, match, "node_modules", "sharp", "lib", "index.js");
        if (fs.existsSync(entry)) return (await import(entry)).default;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not resolve 'sharp'. Install it or run from the repo root.");
}
const sharp = await loadSharp();

const [, , wsUrl, outPath, specJson] = process.argv;
const spec = JSON.parse(specJson);
const W = spec.width || 1440;
const H = spec.height || 900;
const DPR = 2;
const bg = spec.bg || [252, 252, 253];
const tol = spec.tol ?? 8;
const maxBlankRatio = spec.maxBlankRatio ?? 0.97;
const regions = (spec.regions || []).map((r) => ({
  ...r,
  x: r.x * DPR, y: r.y * DPR, w: r.w * DPR, h: r.h * DPR,
  maxBgRatio: r.maxBgRatio ?? 0.96,
  minVariance: r.minVariance ?? 200,
}));

let id = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
const send = (m, p = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function isBg(r, g, b) { return Math.abs(r - bg[0]) <= tol && Math.abs(g - bg[1]) <= tol && Math.abs(b - bg[2]) <= tol; }

async function verify(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  function stats(x, y, w, h) {
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    w = Math.min(width - x, Math.round(w)); h = Math.min(height - y, Math.round(h));
    if (w <= 0 || h <= 0) return { bgRatio: 1, variance: 0, oob: true };
    let bgc = 0, sum = 0, sq = 0, n = 0;
    for (let yy = y; yy < y + h; yy += 2) for (let xx = x; xx < x + w; xx += 2) {
      const i = (yy * width + xx) * channels, r = data[i], g = data[i + 1], b = data[i + 2];
      if (isBg(r, g, b)) bgc++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b; sum += lum; sq += lum * lum; n++;
    }
    const mean = sum / n;
    return { bgRatio: +(bgc / n).toFixed(4), variance: +(sq / n - mean * mean).toFixed(1) };
  }
  const whole = stats(0, 0, width, height);
  const defects = [];
  if (whole.bgRatio > maxBlankRatio) defects.push(`BLANK ${(whole.bgRatio * 100).toFixed(1)}%`);
  const regionResults = regions.map((reg) => {
    const s = stats(reg.x, reg.y, reg.w, reg.h);
    const probs = [];
    if (s.oob) probs.push("oob");
    if (s.bgRatio > reg.maxBgRatio) probs.push(`bg ${(s.bgRatio * 100).toFixed(1)}%>${(reg.maxBgRatio * 100).toFixed(0)}%`);
    if (s.variance < reg.minVariance) probs.push(`flat var ${s.variance}<${reg.minVariance}`);
    if (probs.length) defects.push(`"${reg.name}": ${probs.join(", ")}`);
    return { name: reg.name, ...s, ok: probs.length === 0 };
  });
  return { pass: defects.length === 0, dimensions: `${width}x${height}`, wholeBgRatio: whole.bgRatio, regions: regionResults, defects };
}

ws.onopen = async () => {
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
    await wait(1000);
    // Pre-capture hook: run JS right before the shutter (e.g. hide jump pills that
    // reappear on relayout). Passed as spec.preCapture (a JS expression string).
    if (spec.preCapture) {
      await send("Runtime.evaluate", { expression: spec.preCapture });
      await wait(250);
    }
    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const buf = Buffer.from(shot.data, "base64");
    const v = await verify(buf);
    v.sizeKB = Math.round(buf.length / 1024);
    if (v.pass) {
      fs.writeFileSync(outPath, buf);
      fs.writeFileSync("/tmp/last-capture.png", buf);
      v.saved = outPath;
    } else {
      fs.writeFileSync("/tmp/last-capture.png", buf); // keep for inspection
      v.saved = false;
    }
    console.log(JSON.stringify(v, null, 2));
    await send("Emulation.clearDeviceMetricsOverride");
    ws.close();
    process.exit(v.pass ? 0 : 1);
  } catch (e) { console.error(e); process.exit(2); }
};

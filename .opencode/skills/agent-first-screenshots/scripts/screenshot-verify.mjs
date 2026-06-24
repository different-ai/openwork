// Agent-first screenshot verifier — Layers 1 & 2 (deterministic, no model).
// Layer 1: blank-frame detection via background ratio.
// Layer 2: DOM-guided region sampling — confirm hero regions actually rendered.
//
// Usage:
//   node screenshot-verify.mjs <png-path> '<json-spec>'
// where json-spec = {
//   "bg": [252,252,253],          // background RGB (#fcfcfd)
//   "tol": 8,                       // per-channel tolerance
//   "maxBlankRatio": 0.97,          // whole-image blank threshold
//   "regions": [                    // DOM-derived rects at SCREENSHOT pixel scale (2x)
//     { "name":"hero", "x":440,"y":160,"w":2000,"h":1100, "maxBgRatio":0.92, "minVariance":50 }
//   ]
// }
// Prints JSON verdict and exits 0 (pass) / 1 (fail).

import fs from "node:fs";
import path from "node:path";

// Resolve sharp portably: prefer a normal resolve, else find it in the pnpm store
// by walking up from cwd to a repo root that contains node_modules/.pnpm.
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

const [, , pngPath, specJson] = process.argv;
const spec = specJson ? JSON.parse(specJson) : {};
const bg = spec.bg || [252, 252, 253];
const tol = spec.tol ?? 8;
const maxBlankRatio = spec.maxBlankRatio ?? 0.97;
const regions = spec.regions || [];

function isBg(r, g, b) {
  return Math.abs(r - bg[0]) <= tol && Math.abs(g - bg[1]) <= tol && Math.abs(b - bg[2]) <= tol;
}

const img = sharp(pngPath);
const meta = await img.metadata();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

function regionStats(x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.min(width - x, Math.round(w));
  h = Math.min(height - y, Math.round(h));
  if (w <= 0 || h <= 0) return { bgRatio: 1, variance: 0, pixels: 0, oob: true };
  let bgCount = 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let yy = y; yy < y + h; yy += 2) {        // sample every 2px for speed
    for (let xx = x; xx < x + w; xx += 2) {
      const i = (yy * width + xx) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (isBg(r, g, b)) bgCount++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { bgRatio: +(bgCount / n).toFixed(4), variance: +variance.toFixed(1), pixels: n };
}

const whole = regionStats(0, 0, width, height);
const defects = [];

// Layer 1: blank frame
if (whole.bgRatio > maxBlankRatio) {
  defects.push(`BLANK: ${(whole.bgRatio * 100).toFixed(1)}% background (threshold ${(maxBlankRatio * 100).toFixed(0)}%)`);
}

// Layer 2: per-region checks
const regionResults = regions.map((reg) => {
  const s = regionStats(reg.x, reg.y, reg.w, reg.h);
  const problems = [];
  if (reg.maxBgRatio != null && s.bgRatio > reg.maxBgRatio) {
    problems.push(`empty: ${(s.bgRatio * 100).toFixed(1)}% bg > ${(reg.maxBgRatio * 100).toFixed(0)}%`);
  }
  if (reg.minVariance != null && s.variance < reg.minVariance) {
    problems.push(`flat: variance ${s.variance} < ${reg.minVariance}`);
  }
  if (s.oob) problems.push("out-of-bounds");
  if (problems.length) defects.push(`region "${reg.name}": ${problems.join(", ")}`);
  return { name: reg.name, ...s, problems };
});

const verdict = {
  pass: defects.length === 0,
  dimensions: `${width}x${height}`,
  wholeBgRatio: whole.bgRatio,
  regions: regionResults,
  defects,
};

console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.pass ? 0 : 1);

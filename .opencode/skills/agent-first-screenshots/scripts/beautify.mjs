#!/usr/bin/env node

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

const BG_PRESETS = new Map([
  ["paper", ["#f5f1ea", "#e8e0d2", "#d9cdb8"]],
  ["indigo", ["#312e81", "#6366f1", "#a5b4fc"]],
  ["slate", ["#0f172a", "#334155", "#64748b"]],
  ["peach", ["#fecaca", "#fed7aa", "#fef3c7"]],
  ["ocean", ["#0c4a6e", "#0891b2", "#67e8f9"]],
  ["violet", ["#4c1d95", "#7c3aed", "#c4b5fd"]],
]);
const DEFAULTS = {
  bg: "paper",
  bgAngle: 135,
  padPercent: 7,
  radius: 24,
  shadowBlur: 60,
  shadowOpacity: 0.35,
  shadowOffsetY: 24,
  chrome: "none",
  title: "",
  url: "",
  width: 0,
  ratio: "",
};
const VALUE_FLAGS = new Set([
  "bg",
  "bg-angle",
  "pad",
  "radius",
  "shadow-blur",
  "shadow-opacity",
  "shadow-offset-y",
  "chrome",
  "title",
  "url",
  "width",
  "ratio",
]);

function usage() {
  return `Usage:
  node beautify.mjs <input.png> <output.png> [flags]

Flags:
  --bg <preset|#hex,#hex[,#hex]>   Gradient preset/custom colors (default: paper)
                                     Presets: paper, indigo, slate, peach, ocean, violet
  --bg-angle <deg>                 Gradient angle (default: 135)
  --pad <pct>                      Padding % of window long side (default: 7)
  --radius <px>                    Window corner radius (default: 24)
  --shadow-blur <px>               Shadow blur (default: 60)
  --shadow-opacity <0..1>          Shadow opacity (default: 0.35)
  --shadow-offset-y <px>           Shadow vertical offset (default: 24)
  --chrome none|mac|browser        Optional chrome bar (default: none)
  --title <text>                   Centered title for mac chrome
  --url <text>                     URL text for browser chrome
  --width <px>                     Resize final PNG to this width
  --ratio <w:h>                    Extend background to exact aspect ratio
  --help                           Print this help`;
}

function fail(message) {
  console.error(`Error: ${message}\n\n${usage()}`);
  process.exit(1);
}

function readValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) return [inlineValue, index];
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`Missing value for --${name}.`);
  return [value, index + 1];
}

function numberFlag(value, name, bounds = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`--${name} must be a finite number.`);
  if (bounds.integer && !Number.isInteger(number)) fail(`--${name} must be an integer.`);
  if (bounds.min !== undefined && number < bounds.min) fail(`--${name} must be at least ${bounds.min}.`);
  if (bounds.max !== undefined && number > bounds.max) fail(`--${name} must be at most ${bounds.max}.`);
  return number;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const options = { ...DEFAULTS };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    const name = token.slice(2, equalIndex === -1 ? undefined : equalIndex);
    if (!VALUE_FLAGS.has(name)) fail(`Unknown flag --${name}.`);
    const inlineValue = equalIndex === -1 ? undefined : token.slice(equalIndex + 1);
    const result = readValue(argv, index, name, inlineValue);
    const value = result[0];
    index = result[1];
    switch (name) {
      case "bg": options.bg = value; break;
      case "bg-angle": options.bgAngle = numberFlag(value, name); break;
      case "pad": options.padPercent = numberFlag(value, name, { min: 0 }); break;
      case "radius": options.radius = numberFlag(value, name, { min: 0 }); break;
      case "shadow-blur": options.shadowBlur = numberFlag(value, name, { min: 0 }); break;
      case "shadow-opacity": options.shadowOpacity = numberFlag(value, name, { min: 0, max: 1 }); break;
      case "shadow-offset-y": options.shadowOffsetY = numberFlag(value, name); break;
      case "chrome":
        if (!["none", "mac", "browser"].includes(value)) fail("--chrome must be one of: none, mac, browser.");
        options.chrome = value;
        break;
      case "title": options.title = value; break;
      case "url": options.url = value; break;
      case "width": options.width = numberFlag(value, name, { min: 1, integer: true }); break;
      case "ratio": options.ratio = value; break;
    }
  }
  if (positional.length !== 2) fail("Expected exactly <input.png> and <output.png>.");
  return { inputPath: positional[0], outputPath: positional[1], options };
}

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function parseGradient(value) {
  const preset = BG_PRESETS.get(value.toLowerCase());
  if (preset) return preset;
  const colors = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (colors.length < 2 || colors.length > 3) fail("Custom --bg must be '#hex,#hex' or '#hex,#hex,#hex'.");
  for (const color of colors) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(`Invalid gradient color '${color}'. Use 6-digit hex, e.g. #f5f1ea.`);
  }
  return colors;
}

function gradientEndpoints(angle) {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const scale = 50 / Math.max(Math.abs(dx), Math.abs(dy), 0.0001);
  return { x1: 50 - dx * scale, y1: 50 - dy * scale, x2: 50 + dx * scale, y2: 50 + dy * scale };
}

function pct(value) {
  return `${Math.max(0, Math.min(100, value)).toFixed(3)}%`;
}

function gradientSvg(width, height, colors, angle) {
  const points = gradientEndpoints(angle);
  const stops = colors.map((color, index) => `<stop offset="${(index / (colors.length - 1)) * 100}%" stop-color="${color}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="${pct(points.x1)}" y1="${pct(points.y1)}" x2="${pct(points.x2)}" y2="${pct(points.y2)}">${stops}</linearGradient></defs><rect width="${width}" height="${height}" fill="url(#bg)"/></svg>`;
}

function roundedMaskSvg(width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${r}" ry="${r}" fill="#fff"/></svg>`;
}

function topRoundedRectPath(width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  return `M ${r} 0 H ${width - r} Q ${width} 0 ${width} ${r} V ${height} H 0 V ${r} Q 0 0 ${r} 0 Z`;
}

function trafficLightsSvg(height) {
  const cy = height / 2;
  return `<circle cx="44" cy="${cy}" r="13" fill="#ff5f57"/><circle cx="82" cy="${cy}" r="13" fill="#febc2e"/><circle cx="120" cy="${cy}" r="13" fill="#28c840"/>`;
}

function browserPillSvg(width, height, url) {
  const maxWidth = Math.max(180, width - 320);
  const pillWidth = Math.min(Math.max(560, width * 0.42), maxWidth);
  const pillHeight = 48;
  const x = Math.round((width - pillWidth) / 2);
  const y = Math.round((height - pillHeight) / 2);
  const lockX = x + 28;
  const lockY = y + 16;
  const clipWidth = Math.max(1, pillWidth - 88);
  return `<rect x="${x}" y="${y}" width="${pillWidth}" height="${pillHeight}" rx="20" fill="#fff" stroke="#e5e7eb" stroke-width="1"/><path d="M ${lockX + 3} ${lockY + 9} v -4 a 6 6 0 0 1 12 0 v 4" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round"/><rect x="${lockX}" y="${lockY + 9}" width="18" height="15" rx="4" fill="none" stroke="#9ca3af" stroke-width="2"/><clipPath id="urlClip"><rect x="${x + 58}" y="${y}" width="${clipWidth}" height="${pillHeight}" rx="12"/></clipPath><text clip-path="url(#urlClip)" x="${width / 2}" y="${height / 2 + 1}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif" font-size="22" fill="#6b7280" text-anchor="middle" dominant-baseline="middle">${escapeXml(url)}</text>`;
}

function chromeSvg(width, kind, radius, title, url) {
  const height = kind === "browser" ? 96 : 88;
  const titleText = title ? `<text x="${width / 2}" y="45" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif" font-size="22" font-weight="500" fill="#6b7280" text-anchor="middle" dominant-baseline="middle">${escapeXml(title)}</text>` : "";
  const centerContent = kind === "browser" ? browserPillSvg(width, height, url) : titleText;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${topRoundedRectPath(width, height, radius)}" fill="#f3f4f6"/><line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="#e5e7eb" stroke-width="1"/>${trafficLightsSvg(height)}${centerContent}</svg>`;
}

function shadowSvg(width, height, frame, radius, opacity) {
  const r = Math.min(radius, frame.width / 2, frame.height / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="${r}" ry="${r}" fill="#0a0c14" fill-opacity="${opacity}"/></svg>`;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function parseRatio(value) {
  if (!value) return null;
  const parts = value.split(":").map((part) => part.trim());
  if (parts.length !== 2) fail("--ratio must use the form w:h, e.g. 16:9.");
  const wide = Number(parts[0]);
  const high = Number(parts[1]);
  if (!Number.isFinite(wide) || !Number.isFinite(high) || wide <= 0 || high <= 0) fail("--ratio values must be positive numbers.");
  if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const divisor = greatestCommonDivisor(wide, high);
    return { wide: wide / divisor, high: high / divisor };
  }
  return { wide, high };
}

function fitCanvasToRatio(baseWidth, baseHeight, ratio) {
  if (!ratio) return { width: baseWidth, height: baseHeight };
  if (Number.isInteger(ratio.wide) && Number.isInteger(ratio.high)) {
    const units = Math.max(Math.ceil(baseWidth / ratio.wide), Math.ceil(baseHeight / ratio.high));
    return { width: units * ratio.wide, height: units * ratio.high };
  }
  const target = ratio.wide / ratio.high;
  return baseWidth / baseHeight < target ? { width: Math.ceil(baseHeight * target), height: baseHeight } : { width: baseWidth, height: Math.ceil(baseWidth / target) };
}

async function readPngMetadata(inputPath) {
  if (!fs.existsSync(inputPath)) fail(`Input file does not exist: ${inputPath}`);
  try {
    const metadata = await sharp(inputPath).metadata();
    if (metadata.format !== "png") fail(`Input must be a PNG; decoded format was '${metadata.format || "unknown"}'.`);
    if (!metadata.width || !metadata.height) fail("Input PNG has no readable dimensions.");
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Could not decode input PNG: ${message}`);
  }
}

async function makeWindow(inputPath, metadata, options) {
  const screenshot = await sharp(inputPath).png().toBuffer();
  const chromeHeight = options.chrome === "none" ? 0 : options.chrome === "browser" ? 96 : 88;
  const width = metadata.width;
  const height = metadata.height + chromeHeight;
  const layers = chromeHeight > 0 ? [{ input: Buffer.from(chromeSvg(width, options.chrome, options.radius, options.title, options.url)), left: 0, top: 0 }] : [];
  layers.push({ input: screenshot, left: 0, top: chromeHeight });
  const composed = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
  const rounded = await sharp(composed).ensureAlpha().composite([{ input: Buffer.from(roundedMaskSvg(width, height, options.radius)), blend: "dest-in" }]).png().toBuffer();
  return { buffer: rounded, width, height };
}

async function makeShadowLayer(canvas, windowFrame, options) {
  if (options.shadowOpacity === 0) return null;
  const frame = { ...windowFrame, y: windowFrame.y + options.shadowOffsetY };
  let image = sharp(Buffer.from(shadowSvg(canvas.width, canvas.height, frame, options.radius, options.shadowOpacity)));
  if (options.shadowBlur > 0) image = image.blur(options.shadowBlur);
  return image.png().toBuffer();
}

async function writeBeautifiedImage(inputPath, outputPath, options) {
  const absoluteInput = path.resolve(inputPath);
  const absoluteOutput = path.resolve(outputPath);
  const outputDir = path.dirname(absoluteOutput);
  if (!fs.existsSync(outputDir)) fail(`Output directory does not exist: ${outputDir}`);
  const metadata = await readPngMetadata(absoluteInput);
  const colors = parseGradient(options.bg);
  const windowImage = await makeWindow(absoluteInput, metadata, options);
  const pad = Math.round(Math.max(windowImage.width, windowImage.height) * (options.padPercent / 100));
  const canvas = fitCanvasToRatio(windowImage.width + pad * 2, windowImage.height + pad * 2, parseRatio(options.ratio));
  const windowFrame = { x: Math.round((canvas.width - windowImage.width) / 2), y: Math.round((canvas.height - windowImage.height) / 2), width: windowImage.width, height: windowImage.height };
  const shadow = await makeShadowLayer(canvas, windowFrame, options);
  const composites = shadow ? [{ input: shadow, left: 0, top: 0 }] : [];
  composites.push({ input: windowImage.buffer, left: windowFrame.x, top: windowFrame.y });
  const composed = await sharp(Buffer.from(gradientSvg(canvas.width, canvas.height, colors, options.bgAngle)))
    .composite(composites)
    .removeAlpha()
    .png()
    .toBuffer();
  let output = sharp(composed);
  if (options.width > 0) output = output.resize({ width: options.width });
  await output.removeAlpha().png().toFile(absoluteOutput);
}

const { inputPath, outputPath, options } = parseArgs(process.argv.slice(2));
const sharp = await loadSharp();
try {
  await writeBeautifiedImage(inputPath, outputPath, options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

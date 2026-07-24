import { readFile } from "node:fs/promises";
import { evaluate, type CdpClient } from "./cdp.ts";

const DEFAULT_PADDING_RATIO = 0.06;
const MIN_PADDING_RATIO = 0.02;
const MAX_PADDING_RATIO = 0.3;
const DEFAULT_RADIUS = 18;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

let backgroundDataUrlPromise: Promise<string> | null = null;

/** Presentation framing options for a pretty screenshot composite. */
export interface PrettyOptions {
  /** Ratio of max(shotWidth, shotHeight), clamped to [0.02, 0.3]. Default: 0.06. */
  padding?: number;
  /** Card corner radius in output pixels. Default: 18. */
  radius?: number;
}

/** Pixel-level checks proving the pretty composite kept the evidence honest. */
export interface PrettySampleChecks {
  cornersAreBackground: boolean;
  roundedCornerClipped: boolean;
  shadowDarkensBelowCard: boolean;
  centerIsAppContent: boolean;
}

/** Browser-side composite metadata returned with the rendered data URL. */
export interface PrettyCompositeResult {
  dataUrl: string;
  width: number;
  height: number;
  padding: number;
  radius: number;
  checks: PrettySampleChecks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function backgroundDataUrl(): Promise<string> {
  if (!backgroundDataUrlPromise) {
    backgroundDataUrlPromise = readFile(new URL("./assets/mesh-gradient-bg.png", import.meta.url))
      .then((buffer) => PNG_DATA_URL_PREFIX + buffer.toString("base64"));
  }
  return backgroundDataUrlPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function parsePrettyChecks(value: unknown): PrettySampleChecks | null {
  if (!isRecord(value)) return null;
  const cornersAreBackground = booleanField(value, "cornersAreBackground");
  const roundedCornerClipped = booleanField(value, "roundedCornerClipped");
  const shadowDarkensBelowCard = booleanField(value, "shadowDarkensBelowCard");
  const centerIsAppContent = booleanField(value, "centerIsAppContent");
  if (
    cornersAreBackground === null ||
    roundedCornerClipped === null ||
    shadowDarkensBelowCard === null ||
    centerIsAppContent === null
  ) {
    return null;
  }
  return { cornersAreBackground, roundedCornerClipped, shadowDarkensBelowCard, centerIsAppContent };
}

function parsePrettyResult(value: unknown): PrettyCompositeResult | null {
  if (!isRecord(value)) return null;
  const dataUrl = stringField(value, "dataUrl");
  const width = numberField(value, "width");
  const height = numberField(value, "height");
  const padding = numberField(value, "padding");
  const radius = numberField(value, "radius");
  const checks = parsePrettyChecks(value.checks);
  if (dataUrl === null || width === null || height === null || padding === null || radius === null || checks === null) {
    return null;
  }
  return { dataUrl, width, height, padding, radius, checks };
}

function decodePngDataUrl(dataUrl: string): Buffer {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("Pretty composite returned a non-PNG data URL.");
  }
  const buffer = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), "base64");
  if (buffer.length === 0) {
    throw new Error("Pretty composite returned an empty PNG.");
  }
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Pretty composite returned data that is not a PNG.");
  }
  return buffer;
}

/**
 * Composite a raw CDP screenshot onto the checked-in paper mesh-gradient frame.
 * The render and proof samples run inside the connected page's Chromium via CDP.
 */
export async function compositePrettyFrame(
  client: CdpClient,
  rawPng: Buffer,
  options: PrettyOptions = {},
): Promise<{ buffer: Buffer; result: PrettyCompositeResult }> {
  const paddingRatio = clamp(finiteOrDefault(options.padding, DEFAULT_PADDING_RATIO), MIN_PADDING_RATIO, MAX_PADDING_RATIO);
  const radius = Math.max(0, Math.round(finiteOrDefault(options.radius, DEFAULT_RADIUS)));
  const bgDataUrl = await backgroundDataUrl();
  const rawDataUrl = PNG_DATA_URL_PREFIX + rawPng.toString("base64");
  const expression = `(async () => {
    const bgUrl = ${JSON.stringify(bgDataUrl)};
    const shotUrl = ${JSON.stringify(rawDataUrl)};
    const paddingRatio = ${JSON.stringify(paddingRatio)};
    const radius = ${JSON.stringify(radius)};
    const loadImage = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img;
    };
    const [bg, shot] = await Promise.all([loadImage(bgUrl), loadImage(shotUrl)]);
    const pad = Math.round(Math.max(shot.width, shot.height) * paddingRatio);
    const W = shot.width + 2 * pad;
    const H = shot.height + 2 * pad;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D canvas context for pretty screenshot compositing.");

    const bgScale = Math.max(W / bg.width, H / bg.height);
    const bgWidth = bg.width * bgScale;
    const bgHeight = bg.height * bgScale;
    ctx.drawImage(bg, (W - bgWidth) / 2, (H - bgHeight) / 2, bgWidth, bgHeight);

    const clampPixel = (value, limit) => Math.min(limit - 1, Math.max(0, value));
    const sample = (x, y) => {
      const data = ctx.getImageData(clampPixel(x, W), clampPixel(y, H), 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    };
    const equal = (left, right) => left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
    const luminance = (pixel) => 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
    const points = {
      topLeft: { x: 2, y: 2 },
      topRight: { x: W - 3, y: 2 },
      bottomLeft: { x: 2, y: H - 3 },
      bottomRight: { x: W - 3, y: H - 3 },
      insideCorner: { x: pad + 2, y: pad + 2 },
      belowCard: { x: Math.round(W / 2), y: pad + shot.height + Math.max(3, Math.round(pad * 0.25)) },
    };
    const before = {
      topLeft: sample(points.topLeft.x, points.topLeft.y),
      topRight: sample(points.topRight.x, points.topRight.y),
      bottomLeft: sample(points.bottomLeft.x, points.bottomLeft.y),
      bottomRight: sample(points.bottomRight.x, points.bottomRight.y),
      insideCorner: sample(points.insideCorner.x, points.insideCorner.y),
      belowCard: sample(points.belowCard.x, points.belowCard.y),
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(pad, pad, shot.width, shot.height);
    ctx.clip("evenodd");
    ctx.shadowColor = "rgba(15, 23, 42, 0.38)";
    ctx.shadowBlur = Math.max(12, Math.round(pad * 0.7));
    ctx.shadowOffsetY = Math.max(4, Math.round(pad * 0.16));
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(pad, pad, shot.width, shot.height, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(pad, pad, shot.width, shot.height, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad, pad, shot.width, shot.height, radius);
    ctx.clip();
    ctx.drawImage(shot, pad, pad);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pad + 0.5, pad + 0.5, shot.width - 1, shot.height - 1, Math.max(0, radius - 0.5));
    ctx.stroke();
    ctx.restore();

    const after = {
      topLeft: sample(points.topLeft.x, points.topLeft.y),
      topRight: sample(points.topRight.x, points.topRight.y),
      bottomLeft: sample(points.bottomLeft.x, points.bottomLeft.y),
      bottomRight: sample(points.bottomRight.x, points.bottomRight.y),
      insideCorner: sample(points.insideCorner.x, points.insideCorner.y),
      belowCard: sample(points.belowCard.x, points.belowCard.y),
    };
    const shotCanvas = document.createElement("canvas");
    shotCanvas.width = shot.width;
    shotCanvas.height = shot.height;
    const shotCtx = shotCanvas.getContext("2d");
    if (!shotCtx) throw new Error("Could not create a 2D canvas context for raw screenshot sampling.");
    shotCtx.drawImage(shot, 0, 0);
    const canvasCenterX = clampPixel(Math.round(W / 2), W);
    const canvasCenterY = clampPixel(Math.round(H / 2), H);
    const shotCenterX = clampPixel(canvasCenterX - pad, shot.width);
    const shotCenterY = clampPixel(canvasCenterY - pad, shot.height);
    const canvasCenter = sample(canvasCenterX, canvasCenterY);
    const rawCenterData = shotCtx.getImageData(shotCenterX, shotCenterY, 1, 1).data;
    const rawCenter = { r: rawCenterData[0], g: rawCenterData[1], b: rawCenterData[2], a: rawCenterData[3] };

    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: W,
      height: H,
      padding: pad,
      radius,
      checks: {
        cornersAreBackground:
          equal(after.topLeft, before.topLeft) &&
          equal(after.topRight, before.topRight) &&
          equal(after.bottomLeft, before.bottomLeft) &&
          equal(after.bottomRight, before.bottomRight),
        roundedCornerClipped: radius >= 6 && equal(after.insideCorner, before.insideCorner),
        shadowDarkensBelowCard: luminance(before.belowCard) - luminance(after.belowCard) >= 4,
        centerIsAppContent: equal(canvasCenter, rawCenter),
      },
    };
  })()`;

  const value = await evaluate(client, expression, { awaitPromise: true });
  const result = parsePrettyResult(value);
  if (!result) {
    throw new Error("Pretty composite returned an unexpected result shape.");
  }
  return { buffer: decodePngDataUrl(result.dataUrl), result };
}

import type {
  GrainGradientParams,
  GrainGradientShape,
  MeshGradientParams,
} from "@paper-design/shaders";

export type PaperMeshGradientConfig = Required<
  Pick<
    MeshGradientParams,
    | "colors"
    | "distortion"
    | "swirl"
    | "grainMixer"
    | "grainOverlay"
    | "speed"
    | "frame"
  >
>;

export type PaperGrainGradientConfig = Required<
  Pick<
    GrainGradientParams,
    | "colorBack"
    | "colors"
    | "softness"
    | "intensity"
    | "noise"
    | "shape"
    | "speed"
    | "frame"
  >
>;

export type SeededPaperOption = {
  seed?: string;
};

export const paperMeshGradientDefaults: PaperMeshGradientConfig = {
  colors: ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
  distortion: 0.8,
  swirl: 0.1,
  grainMixer: 0,
  grainOverlay: 0,
  speed: 0.1,
  frame: 0,
};

export const paperGrainGradientDefaults: PaperGrainGradientConfig = {
  colors: ["#7300ff", "#eba8ff", "#00bfff", "#2b00ff"],
  colorBack: "#000000",
  softness: 0.5,
  intensity: 0.5,
  noise: 0.25,
  shape: "ripple",
  speed: 0.4,
  frame: 0,
};

const grainShapes: GrainGradientShape[] = [
  "corners",
  "wave",
  "dots",
  "truchet",
  "ripple",
  "blob",
  "sphere",
];

const meshPaletteFamilies = [
  ["#e0eaff", "#241d9a", "#f75092", "#9f50d3"],
  ["#ddfff5", "#006c67", "#35d8c0", "#8cff7a"],
  ["#ffe5c2", "#8a2500", "#ff7b39", "#ffd166"],
  ["#f5f7ff", "#0d1b52", "#3f8cff", "#00c2ff"],
  ["#fff2f2", "#6f1237", "#ff4d6d", "#ffb703"],
  ["#f0ffe1", "#254d00", "#8cc63f", "#00a76f"],
  ["#f5edff", "#44206b", "#b5179e", "#7209b7"],
  ["#f4f1ea", "#3a2f1f", "#927c55", "#d0c2a8"],
];

const grainPaletteFamilies = [
  ["#7300ff", "#eba8ff", "#00bfff", "#2b00ff"],
  ["#0df2c1", "#0b7cff", "#74efff", "#1a2cff"],
  ["#ff7a18", "#ffd166", "#ff4d6d", "#5f0f40"],
  ["#8dff6a", "#1f7a1f", "#d7ff70", "#00c48c"],
  ["#f6a6ff", "#7027c9", "#ff66c4", "#20115b"],
  ["#b9ecff", "#006494", "#00a6a6", "#072ac8"],
  ["#f7f0d6", "#8c5e34", "#d68c45", "#4e342e"],
  ["#ffd9f5", "#ff006e", "#8338ec", "#3a0ca3"],
];

const paletteModes = [
  {
    hueOffsets: [0, 22, 182, 238],
    saturations: [0.92, 0.7, 0.84, 0.74],
    lightnesses: [0.82, 0.28, 0.6, 0.5],
  },
  {
    hueOffsets: [0, 118, 242, 304],
    saturations: [0.88, 0.76, 0.82, 0.7],
    lightnesses: [0.8, 0.42, 0.58, 0.48],
  },
  {
    hueOffsets: [0, 44, 156, 214],
    saturations: [0.94, 0.78, 0.86, 0.72],
    lightnesses: [0.78, 0.4, 0.6, 0.46],
  },
  {
    hueOffsets: [0, 76, 184, 326],
    saturations: [0.86, 0.8, 0.78, 0.76],
    lightnesses: [0.82, 0.52, 0.42, 0.58],
  },
  {
    hueOffsets: [0, 140, 196, 224],
    saturations: [0.84, 0.7, 0.76, 0.88],
    lightnesses: [0.86, 0.46, 0.36, 0.54],
  },
  {
    hueOffsets: [0, 162, 212, 342],
    saturations: [0.9, 0.72, 0.8, 0.82],
    lightnesses: [0.8, 0.38, 0.52, 0.56],
  },
];

type MeshGradientOverrides = SeededPaperOption &
  Partial<PaperMeshGradientConfig>;
type GrainGradientOverrides = SeededPaperOption &
  Partial<PaperGrainGradientConfig>;

export function getSeededPaperMeshGradientConfig(
  seed: string,
): PaperMeshGradientConfig {
  const random = createRandom(seed, "mesh");

  return {
    colors: createSeededPalette(
      paperMeshGradientDefaults.colors,
      seed,
      "mesh-colors",
      {
        families: meshPaletteFamilies,
        hueShift: 42,
        saturationShift: 0.18,
        lightnessShift: 0.14,
        baseBlend: [0.08, 0.2],
      },
    ),
    distortion: roundTo(clamp(0.58 + random() * 0.32, 0, 1), 3),
    swirl: roundTo(clamp(0.03 + random() * 0.28, 0, 1), 3),
    grainMixer: roundTo(clamp(random() * 0.18, 0, 1), 3),
    grainOverlay: roundTo(clamp(random() * 0.12, 0, 1), 3),
    speed: 0.5,
    frame: Math.round(random() * 240000),
  };
}

export function getSeededPaperGrainGradientConfig(
  seed: string,
): PaperGrainGradientConfig {
  const random = createRandom(seed, "grain");
  const colors = createSeededPalette(
    paperGrainGradientDefaults.colors,
    seed,
    "grain-colors",
    {
      families: grainPaletteFamilies,
      hueShift: 58,
      saturationShift: 0.22,
      lightnessShift: 0.18,
      baseBlend: [0.04, 0.14],
    },
  );
  const anchorColor = colors[Math.floor(random() * colors.length)] ?? colors[0];

  return {
    colors,
    colorBack: createSeededBackground(anchorColor, seed, "grain-background"),
    softness: roundTo(clamp(0.22 + random() * 0.56, 0, 1), 3),
    intensity: roundTo(clamp(0.2 + random() * 0.6, 0, 1), 3),
    noise: roundTo(clamp(0.12 + random() * 0.34, 0, 1), 3),
    shape:
      grainShapes[Math.floor(random() * grainShapes.length)] ??
      paperGrainGradientDefaults.shape,
    speed: roundTo(0.2 + random() * 0.6, 3),
    frame: Math.round(random() * 320000),
  };
}

export function resolvePaperMeshGradientConfig(
  options: MeshGradientOverrides = {},
): PaperMeshGradientConfig {
  const seeded = options.seed
    ? getSeededPaperMeshGradientConfig(options.seed)
    : paperMeshGradientDefaults;

  return {
    colors: options.colors ?? seeded.colors,
    distortion: options.distortion ?? seeded.distortion,
    swirl: options.swirl ?? seeded.swirl,
    grainMixer: options.grainMixer ?? seeded.grainMixer,
    grainOverlay: options.grainOverlay ?? seeded.grainOverlay,
    speed: options.speed ?? seeded.speed,
    frame: options.frame ?? seeded.frame,
  };
}

export function resolvePaperGrainGradientConfig(
  options: GrainGradientOverrides = {},
): PaperGrainGradientConfig {
  const seeded = options.seed
    ? getSeededPaperGrainGradientConfig(options.seed)
    : paperGrainGradientDefaults;

  return {
    colors: options.colors ?? seeded.colors,
    colorBack: options.colorBack ?? seeded.colorBack,
    softness: options.softness ?? seeded.softness,
    intensity: options.intensity ?? seeded.intensity,
    noise: options.noise ?? seeded.noise,
    shape: options.shape ?? seeded.shape,
    speed: options.speed ?? seeded.speed,
    frame: options.frame ?? seeded.frame,
  };
}

function buildSeedSource(seed: string) {
  const trimmedSeed = seed.trim();
  const separatorIndex = trimmedSeed.indexOf("_");

  if (separatorIndex === -1) {
    return trimmedSeed;
  }

  const prefix = trimmedSeed.slice(0, separatorIndex);
  const suffix = trimmedSeed.slice(separatorIndex + 1);
  const suffixTail = suffix.slice(5) || suffix;

  return `${trimmedSeed}|${prefix}|${suffix}|${suffixTail}`;
}

function createSeededPalette(
  baseColors: string[],
  seed: string,
  namespace: string,
  options: {
    families: string[][];
    hueShift: number;
    saturationShift: number;
    lightnessShift: number;
    baseBlend: [number, number];
  },
) {
  const familyRandom = createRandom(seed, `${namespace}:family`);
  const primaryIndex = Math.floor(familyRandom() * options.families.length);
  const secondaryOffset =
    1 + Math.floor(familyRandom() * (options.families.length - 1));
  const secondaryIndex =
    (primaryIndex + secondaryOffset) % options.families.length;
  const primary = options.families[primaryIndex] ?? baseColors;
  const secondary =
    options.families[secondaryIndex] ?? [...baseColors].reverse();
  const primaryShift = Math.floor(familyRandom() * primary.length);
  const secondaryShift = Math.floor(familyRandom() * secondary.length);
  const paletteMode =
    paletteModes[Math.floor(familyRandom() * paletteModes.length)] ??
    paletteModes[0];
  const baseHue = familyRandom() * 360;

  return baseColors.map((color, index) => {
    const random = createRandom(seed, `${namespace}:${index}`);
    const primaryColor =
      primary[(index + primaryShift) % primary.length] ?? color;
    const secondaryColor =
      secondary[(index + secondaryShift) % secondary.length] ?? primaryColor;
    const proceduralColor = hslToHex(
      (baseHue +
        paletteMode.hueOffsets[index % paletteMode.hueOffsets.length] +
        (random() * 2 - 1) * 18 +
        360) %
        360,
      clamp(
        paletteMode.saturations[index % paletteMode.saturations.length] +
          (random() * 2 - 1) * 0.08,
        0,
        1,
      ),
      clamp(
        paletteMode.lightnesses[index % paletteMode.lightnesses.length] +
          (random() * 2 - 1) * 0.08,
        0,
        1,
      ),
    );
    const mixedFamilyColor = mixHexColors(
      primaryColor,
      secondaryColor,
      0.18 + random() * 0.64,
    );
    const remixedFamilyColor = mixHexColors(
      mixedFamilyColor,
      primary[(index + secondaryShift + 1) % primary.length] ??
        mixedFamilyColor,
      random() * 0.32,
    );
    const proceduralFamilyColor = mixHexColors(
      proceduralColor,
      remixedFamilyColor,
      0.22 + random() * 0.34,
    );
    const [minBaseBlend, maxBaseBlend] = options.baseBlend;
    const blendedBaseColor = mixHexColors(
      proceduralFamilyColor,
      color,
      minBaseBlend + random() * (maxBaseBlend - minBaseBlend),
    );

    return adjustHexColor(blendedBaseColor, {
      hueShift: (random() * 2 - 1) * options.hueShift + (random() * 2 - 1) * 14,
      saturationShift: (random() * 2 - 1) * options.saturationShift + 0.06,
      lightnessShift: (random() * 2 - 1) * options.lightnessShift,
    });
  });
}

function createSeededBackground(
  baseColor: string,
  seed: string,
  namespace: string,
) {
  const [red, green, blue] = hexToRgb(baseColor);
  const [hue] = rgbToHsl(red, green, blue);
  const random = createRandom(seed, namespace);

  return hslToHex(
    hue,
    clamp(0.18 + random() * 0.18, 0, 1),
    clamp(0.03 + random() * 0.09, 0, 1),
  );
}

function adjustHexColor(
  hex: string,
  adjustments: {
    hueShift: number;
    saturationShift: number;
    lightnessShift: number;
  },
) {
  const [red, green, blue] = hexToRgb(hex);
  const [hue, saturation, lightness] = rgbToHsl(red, green, blue);

  return hslToHex(
    (hue + adjustments.hueShift + 360) % 360,
    clamp(saturation + adjustments.saturationShift, 0, 1),
    clamp(lightness + adjustments.lightnessShift, 0, 1),
  );
}

function mixHexColors(colorA: string, colorB: string, amount: number) {
  const [redA, greenA, blueA] = hexToRgb(colorA);
  const [redB, greenB, blueB] = hexToRgb(colorB);
  const mixAmount = clamp(amount, 0, 1);

  return rgbToHex(
    Math.round(redA + (redB - redA) * mixAmount),
    Math.round(greenA + (greenB - greenA) * mixAmount),
    Math.round(blueA + (blueB - blueA) * mixAmount),
  );
}

function createRandom(seed: string, namespace: string) {
  return mulberry32(hashString(`${buildSeedSource(seed)}::${namespace}`));
}

function hashString(input: string) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function mulberry32(seed: number) {
  return function nextRandom() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, precision: number) {
  const power = 10 ** precision;
  return Math.round(value * power) / power;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace(/^#/, "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : normalized;

  if (expanded.length !== 6) {
    throw new Error(`Unsupported hex color: ${hex}`);
  }

  const value = Number.parseInt(expanded, 16);

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl(
  red: number,
  green: number,
  blue: number,
): [number, number, number] {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const max = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const min = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return [0, 0, lightness];
  }

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;

  switch (max) {
    case normalizedRed:
      hue =
        (normalizedGreen - normalizedBlue) / delta +
        (normalizedGreen < normalizedBlue ? 6 : 0);
      break;
    case normalizedGreen:
      hue = (normalizedBlue - normalizedRed) / delta + 2;
      break;
    default:
      hue = (normalizedRed - normalizedGreen) / delta + 4;
      break;
  }

  return [hue * 60, saturation, lightness];
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return rgbToHex(value, value, value);
  }

  const hueToRgb = (p: number, q: number, t: number) => {
    let normalizedT = t;

    if (normalizedT < 0) normalizedT += 1;
    if (normalizedT > 1) normalizedT -= 1;
    if (normalizedT < 1 / 6) return p + (q - p) * 6 * normalizedT;
    if (normalizedT < 1 / 2) return q;
    if (normalizedT < 2 / 3) return p + (q - p) * (2 / 3 - normalizedT) * 6;
    return p;
  };

  const normalizedHue = hue / 360;
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const red = hueToRgb(p, q, normalizedHue + 1 / 3);
  const green = hueToRgb(p, q, normalizedHue);
  const blue = hueToRgb(p, q, normalizedHue - 1 / 3);

  return rgbToHex(
    Math.round(red * 255),
    Math.round(green * 255),
    Math.round(blue * 255),
  );
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

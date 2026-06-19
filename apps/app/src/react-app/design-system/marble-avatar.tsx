/** @jsxImportSource react */
import Avatar from "boring-avatars";

const DEFAULT_AVATAR_COLORS = ["#0a0310", "#49007e", "#ff005b", "#ff7d10", "#ffb238"];

const AVATAR_COLOR_PALETTES = [
  DEFAULT_AVATAR_COLORS,
  ["#1c2130", "#028f76", "#b3e099", "#ffeaad", "#d14334"],
  ["#bfe0c0", "#160921", "#f06e75", "#f2af60", "#d0d26f"],
  ["#1f0441", "#fc1068", "#fcab10", "#f9ce07", "#0ce3e8"],
  ["#4aedd7", "#705647", "#ed6d4a", "#ffca64", "#3fd97f"],
  ["#ff5252", "#ff7752", "#ff9a52", "#ffb752", "#5e405b"],
  ["#37193b", "#e75a7a", "#f59275", "#f5c273", "#aeb395"],
  ["#913f33", "#ff705f", "#ffaa67", "#ffdfab", "#9fb9c2"],
  ["#13141a", "#a90448", "#fb3640", "#fda543", "#17c69b"],
];

export type MarbleAvatarProps = {
  seed: string;
  className?: string;
  square?: boolean;
};

export function MarbleAvatar({ seed, className, square }: MarbleAvatarProps) {
  const normalizedSeed = seed.trim() || "openwork";

  return (
    <Avatar
      variant="marble"
      name={normalizedSeed}
      colors={avatarColorsForSeed(normalizedSeed)}
      square={square}
      className={className}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    />
  );
}

function avatarColorsForSeed(seed: string) {
  return AVATAR_COLOR_PALETTES[hashString(seed) % AVATAR_COLOR_PALETTES.length] ?? DEFAULT_AVATAR_COLORS;
}

function hashString(input: string) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

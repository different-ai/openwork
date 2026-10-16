import type { FileTone } from "@openwork-ee/workbot-client"

/**
 * Workbot's look, the same values as the web page (ee/packages/workbot-ui/src/styles.css, `--wb-*`): one place to
 * change them for the phone. Shadows use React Native's `boxShadow`, written as on the web.
 */
export const color = {
  bg: "#fbfcfd",
  ink: "#011627",
  onInk: "#eef2f6",
  text: "#11181c",
  muted: "#687076",
  faint: "#8b9196",
  bubble: "#e9edf0",
  chip: "#f1f3f5",
  tray: "#f6f8f9",
  surface: "#ffffff",
  disabled: "#c1c8cd",
  shimmerLight: "#c9ced3",
  hairline: "#0116270f",
  rowLine: "#0116270d",
  ring: "#01162717",
  danger: "#c4302b",
  userBubble: "#eef1f4",
  computerScreen: "#e6f4fe",
  computerFrame: "#687076",
  computerLine: "#5eb1ef",
  computerLineLive: "#0090ff",
  typePdf: "#c4302b",
  typeDoc: "#2b5797",
  typeSheet: "#1d7044",
  typeSlides: "#c55a11",
  typeImage: "#6e56cf",
} as const

export const shadow = {
  card: "0 0 0 1px #0116270f, 0 1px 2px #0116270a",
  composer: "0 0 0 1px #01162717, 0 4px 14px -6px #0116271a",
  mark: "0 6px 16px -8px #01162780",
  panel: "0 0 0 1px #0116270d, 0 12px 32px -12px #01162724, 0 2px 6px -2px #0116270f",
  ring: "0 0 0 1px #01162717",
} as const

export const toneColor: Record<FileTone, string> = {
  pdf: color.typePdf,
  doc: color.typeDoc,
  sheet: color.typeSheet,
  slides: color.typeSlides,
  image: color.typeImage,
  muted: color.muted,
}

/** The widest a conversation column gets (the web's 640px), so long lines stay readable on big phones. */
export const COLUMN = 640

/** The smallest a tap target gets. */
export const TAP = 44

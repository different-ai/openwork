export type ShortcutOs = "macos" | "other";

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key" | "code"
> & {
  getModifierState?: (key: string) => boolean;
};

const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;
type ShortcutModifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "AltGraph", "Shift", "OS", "Hyper", "Super", "CapsLock", "Fn"]);

export function resolveShortcutOs(
  os: "macos" | "windows" | "linux" | undefined,
  navigatorPlatform: string,
): ShortcutOs {
  if (os === "macos" || (os === undefined && /Mac/i.test(navigatorPlatform))) return "macos";
  return "other";
}

function keyFromEvent(event: ShortcutKeyEvent): string | null {
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  const key = event.key ?? "";
  if (!key || MODIFIER_KEYS.has(key)) return null;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function chordFromEvent(event: ShortcutKeyEvent, os: ShortcutOs): string | null {
  if (event.getModifierState?.("AltGraph")) return null;
  const key = keyFromEvent(event);
  if (!key) return null;
  const modifiers = new Set<ShortcutModifier>();
  if (os === "macos") {
    if (event.metaKey) modifiers.add("Mod");
    if (event.ctrlKey) modifiers.add("Ctrl");
  } else {
    if (event.ctrlKey) modifiers.add("Mod");
    if (event.metaKey) modifiers.add("Meta");
  }
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function splitChord(chord: string) {
  const parts = chord.split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  return { modifiers: new Set(parts), key };
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_SYMBOL_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];

export function formatChord(chord: string, os: ShortcutOs): string {
  const { modifiers, key } = splitChord(chord);
  if (os === "macos") {
    return `${MAC_SYMBOL_ORDER.filter((modifier) => modifiers.has(modifier)).map((modifier) => MAC_SYMBOLS[modifier]).join("")}${key}`;
  }
  const names: Record<string, string> = { Mod: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)).map((modifier) => names[modifier] ?? modifier), key].join("+");
}

const BUILT_IN_CHORDS: ReadonlyArray<{ chord: string; label: string; os?: ShortcutOs }> = [
  { chord: "Mod+Shift+F", label: "Search sessions" },
  { chord: "Mod+Shift+T", label: "Previous tab" },
  { chord: "Mod+Shift+E", label: "Archive session" },
  { chord: "Ctrl+Shift+M", label: "Next saved model", os: "macos" },
  { chord: "Mod+Shift+M", label: "Next saved model", os: "other" },
  { chord: "Ctrl+Shift+T", label: "Cycle reasoning backward", os: "macos" },
  { chord: "Mod+Alt+T", label: "Cycle reasoning", os: "other" },
  { chord: "Mod+Alt+Shift+T", label: "Cycle reasoning backward", os: "other" },
  { chord: "Mod+Alt+/", label: "Change model" },
  { chord: "Ctrl+Shift+F", label: "Toggle Fast", os: "macos" },
  { chord: "Mod+Alt+F", label: "Toggle Fast", os: "other" },
];

export type ChordProblem =
  | { kind: "needs_modifier" }
  | { kind: "built_in"; label: string };

export function chordProblem(chord: string, os: ShortcutOs): ChordProblem | null {
  const { modifiers, key } = splitChord(chord);
  if (!key) return { kind: "needs_modifier" };
  const primary = modifiers.has("Mod") || modifiers.has("Ctrl");
  const secondary = modifiers.has("Alt") || modifiers.has("Shift");
  if (!primary || !secondary) return { kind: "needs_modifier" };
  const builtIn = BUILT_IN_CHORDS.find((entry) => entry.chord === chord && (!entry.os || entry.os === os));
  return builtIn ? { kind: "built_in", label: builtIn.label } : null;
}

export function nextFreeChord(taken: ReadonlySet<string>): string | null {
  for (let digit = 1; digit <= 9; digit += 1) {
    const chord = `Mod+Alt+${digit}`;
    if (!taken.has(chord)) return chord;
  }
  return null;
}

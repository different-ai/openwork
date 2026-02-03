const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"] as const;

type ModifierKey = (typeof MODIFIER_ORDER)[number];

type ParsedKeybind = {
  key: string;
  modifiers: Record<ModifierKey, boolean>;
};

const normalizeKey = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const normalized =
    lower === " "
      ? "space"
      : lower === "escape"
        ? "esc"
        : lower === "arrowup"
          ? "up"
          : lower === "arrowdown"
            ? "down"
            : lower === "arrowleft"
              ? "left"
              : lower === "arrowright"
                ? "right"
                : lower;
  return normalized;
};

const normalizeModifier = (value: string): ModifierKey | null => {
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "cmd" || cleaned === "meta" || cleaned === "command" || cleaned === "⌘") return "cmd";
  if (cleaned === "ctrl" || cleaned === "control" || cleaned === "^") return "ctrl";
  if (cleaned === "alt" || cleaned === "option" || cleaned === "opt" || cleaned === "⌥") return "alt";
  if (cleaned === "shift" || cleaned === "⇧") return "shift";
  return null;
};

const emptyModifiers = (): Record<ModifierKey, boolean> => ({
  cmd: false,
  ctrl: false,
  alt: false,
  shift: false,
});

const parseKeybind = (value: string): ParsedKeybind | null => {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const modifiers = emptyModifiers();
  let key = "";
  for (const part of parts) {
    const modifierKey = normalizeModifier(part);
    if (modifierKey) {
      modifiers[modifierKey] = true;
    } else {
      key = normalizeKey(part);
    }
  }
  if (!key) return null;
  return { key, modifiers };
};

const formatKeybind = (parsed: ParsedKeybind) => {
  const parts: string[] = MODIFIER_ORDER.filter((modifier) => parsed.modifiers[modifier]);
  parts.push(parsed.key);
  return parts.join("+");
};

export const normalizeKeybind = (value: string) => {
  const parsed = parseKeybind(value);
  if (!parsed) return null;
  return formatKeybind(parsed);
};

export const keybindFromEvent = (event: KeyboardEvent) => {
  const key = normalizeKey(event.key);
  if (!key || key === "meta" || key === "control" || key === "shift" || key === "alt") return null;
  const parsed: ParsedKeybind = {
    key,
    modifiers: {
      cmd: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    },
  };
  return formatKeybind(parsed);
};

export const matchKeybind = (event: KeyboardEvent, keybind: string) => {
  const parsed = parseKeybind(keybind);
  if (!parsed) return false;
  const key = normalizeKey(event.key);
  return (
    key === parsed.key &&
    event.metaKey === parsed.modifiers.cmd &&
    event.ctrlKey === parsed.modifiers.ctrl &&
    event.altKey === parsed.modifiers.alt &&
    event.shiftKey === parsed.modifiers.shift
  );
};

export const formatKeybindLabel = (keybind: string) => {
  const parsed = parseKeybind(keybind);
  if (!parsed) return keybind;
  const parts: string[] = MODIFIER_ORDER.filter((modifier) => parsed.modifiers[modifier]).map((modifier) => {
    switch (modifier) {
      case "cmd":
        return "Cmd";
      case "ctrl":
        return "Ctrl";
      case "alt":
        return "Alt";
      case "shift":
        return "Shift";
      default:
        return modifier;
    }
  });
  const keyLabel = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.toUpperCase();
  parts.push(keyLabel);
  return parts.join(" + ");
};

export const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(target.closest("[contenteditable='true']"));
};

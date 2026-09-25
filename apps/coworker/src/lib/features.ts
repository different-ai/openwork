/**
 * Optional features. A new person starts with a small, calm app; each of these
 * is off until they turn it on in Settings → Features. Off means off
 * everywhere: the interface for it is gone, coworkers are not told about it
 * and cannot use its tools, and any automation it drives does not run.
 * Turning a feature off never deletes what it holds; turning it back on
 * brings it back as it was.
 */
export const FEATURES = [
  {
    id: "calendar",
    label: "Calendar",
    detail: "Events, recurring assignments and schedules. While off, nothing runs on a schedule on this Mac and coworkers don't offer to set one up.",
  },
  {
    id: "computerUse",
    label: "Computer use",
    detail: "Coworkers can operate apps on this Mac, with your approval for each app.",
  },
  {
    id: "memory",
    label: "Memory settings",
    detail: "See and edit what each coworker remembers. Memory works either way, and you can always ask a coworker what it remembers.",
  },
  {
    id: "abilities",
    label: "Abilities",
    detail: "Choose which skills and apps each coworker may use. While off, coworkers keep what they can use now, and new ones can use everything.",
  },
  {
    id: "appsTools",
    label: "Apps & tools",
    detail: "Add and manage apps, skills and tools for each coworker. Whatever is already connected keeps working either way.",
  },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];
export type Features = Record<FeatureId, boolean>;

export const DEFAULT_FEATURES: Features = { calendar: false, computerUse: false, memory: false, abilities: false, appsTools: false };

/** Only an explicit `true` turns a feature on. */
export function normalizeFeatures(value: unknown, base: Features = DEFAULT_FEATURES): Features {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(FEATURES.map(({ id }) => [id, typeof source[id] === "boolean" ? source[id] : base[id]])) as Features;
}

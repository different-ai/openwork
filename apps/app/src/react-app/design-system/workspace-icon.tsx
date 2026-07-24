/** @jsxImportSource react */

/** Plain solid markers from Paper — muted plane colors, no gradients/pictograms. */
const PLANE_COLORS = [
  "#D94A5B",
  "#B85F7A",
  "#C79245",
  "#5B8A72",
  "#5B6FA8",
  "#C27A4A",
  "#9B6B8A",
  "#4A8B8C",
  "#7A6BA8",
  "#6B8FA3",
];

export type WorkspaceIconProps = {
  workspaceId: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
};

export function WorkspaceIcon({ workspaceId, sizeClass = "size-4" }: WorkspaceIconProps) {
  const color = PLANE_COLORS[hashString(workspaceId.trim() || "openwork") % PLANE_COLORS.length] ?? PLANE_COLORS[0];

  return (
    <span
      className={`${sizeClass} shrink-0 rounded-full`}
      style={{ backgroundColor: color }}
      role="presentation"
      aria-hidden="true"
    />
  );
}

function hashString(input: string) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

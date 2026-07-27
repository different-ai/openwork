/** Strong solid markers for dark sidebars — hashed per workspace, no gradients. */
export const WORKSPACE_AVATAR_COLORS = [
  "#E23B4C",
  "#D44A7A",
  "#D9921A",
  "#1F9A62",
  "#3B6AE0",
  "#E06A28",
  "#A84FA0",
  "#1A9A9C",
  "#6B4FD4",
  "#2A8FBF",
] as const;

export type WorkspaceAvatarColor = (typeof WORKSPACE_AVATAR_COLORS)[number];

export function workspaceAvatarInitials(label: string) {
  const parts = label
    .trim()
    .split(/[\s/_.-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const single = parts[0] ?? "";
    return single.slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? "";
  return `${first}${second}`.toUpperCase();
}

export function workspaceAvatarColor(workspaceId: string) {
  const seed = workspaceId.trim() || "openwork";
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return WORKSPACE_AVATAR_COLORS[(hash >>> 0) % WORKSPACE_AVATAR_COLORS.length]
    ?? WORKSPACE_AVATAR_COLORS[0];
}

export function resolveWorkspaceAvatarColor(
  workspaceId: string,
  preferredColor?: string | null,
) {
  const trimmed = preferredColor?.trim() ?? "";
  if (trimmed && /^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  return workspaceAvatarColor(workspaceId);
}

/** Read a local image file and shrink it to a small square data URL for localStorage. */
export async function readWorkspaceAvatarImage(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare avatar image");

    const minSide = Math.min(image.width, image.height);
    const sourceX = (image.width - minSide) / 2;
    const sourceY = (image.height - minSide) / 2;
    context.drawImage(image, sourceX, sourceY, minSide, minSide, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read image"));
    image.src = src;
  });
}

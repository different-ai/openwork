export const catalogCardSwatches = [
  "#2563eb",
  "#5a67d8",
  "#f97316",
  "#10b981",
] as const;

export type CatalogCardSwatch = (typeof catalogCardSwatches)[number];

const referenceSwatches: Record<string, CatalogCardSwatch> = {
  "ben private marketplace": "#5a67d8",
  "plan my day": "#5a67d8",
  "review missed messages": "#f97316",
};

export const catalogCardClassName =
  "group block overflow-hidden rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)] focus-visible:ring-offset-2";

type CatalogColorRailProps = {
  itemId: string;
  itemName: string;
  size: "card" | "compact" | "detail";
};

const railSizeClasses: Record<CatalogColorRailProps["size"], string> = {
  card: "w-[68px]",
  compact: "w-[64px]",
  detail: "w-[96px]",
};

function hashIdentifier(identifier: string) {
  let hash = 2166136261;
  for (const character of identifier) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getCatalogCardSwatch(itemId: string, itemName: string): CatalogCardSwatch {
  const normalizedName = itemName.trim().toLowerCase();
  if (normalizedName.startsWith("posthog")) return "#2563eb";

  const referenceSwatch = referenceSwatches[normalizedName];
  if (referenceSwatch) return referenceSwatch;

  return catalogCardSwatches[hashIdentifier(itemId) % catalogCardSwatches.length];
}

export function CatalogColorRail({ itemId, itemName, size }: CatalogColorRailProps) {
  const swatch = getCatalogCardSwatch(itemId, itemName);

  return (
    <div
      aria-hidden="true"
      className={`shrink-0 ${railSizeClasses[size]}`}
      data-catalog-card-swatch={swatch}
      style={{ backgroundColor: swatch }}
    />
  );
}

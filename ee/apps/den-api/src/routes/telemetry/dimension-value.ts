import { createHash } from "node:crypto"

function slugifyDimensionLabel(label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "dimension"
}

export function deriveDimensionValue(type: string, label: string) {
  const hash = createHash("sha256").update(`${type}:${label.trim().toLowerCase()}`).digest("hex").slice(0, 10)
  const suffix = `-${hash}`
  return `${slugifyDimensionLabel(label).slice(0, 128 - suffix.length)}${suffix}`
}

/** Resources are independent of placement. `web` drives Den; `appWeb` drives the app. */
export type WorldSurface = "appWeb" | "desktop" | "web";
export type WorldService = "den" | "mock";
export interface WorldResources {
  readonly surfaces: readonly WorldSurface[];
  readonly services: readonly WorldService[];
  /** Required for native worlds: the capability a browser cannot prove. */
  readonly nativeReason?: string;
}

export function validateWorldResources(value: unknown): asserts value is WorldResources {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("surfaces" in value) || !("services" in value)
    || !Array.isArray(value.surfaces) || !Array.isArray(value.services)) {
    throw new Error("World resources must declare both surfaces and services arrays.");
  }
  for (const surface of value.surfaces) {
    if (!["appWeb", "desktop", "web"].includes(surface)) throw new Error(`Unknown world surface: ${surface}`);
  }
  for (const service of value.services) {
    if (!["den", "mock"].includes(service)) throw new Error(`Unknown world service: ${service}`);
  }
  if (new Set(value.surfaces).size !== value.surfaces.length || new Set(value.services).size !== value.services.length) {
    throw new Error("World resources must not contain duplicate declarations.");
  }
  const nativeReason = "nativeReason" in value ? value.nativeReason : undefined;
  if (nativeReason !== undefined && (typeof nativeReason !== "string" || !nativeReason.trim())) {
    throw new Error("World resources nativeReason must be a non-empty string.");
  }
  if (value.surfaces.includes("desktop") && !nativeReason) {
    throw new Error("A desktop world must explain its nativeReason; ordinary app UI belongs in appWeb.");
  }
  if (value.surfaces.includes("web") && !value.services.includes("den")) {
    throw new Error("seed.web drives Den UI and requires the den service; use appWeb for the app.");
  }
}

/** A migration selector may validate a world, never change its implementation. */
export function validateWorldSurfaceSelection(resources: WorldResources, requested?: string): void {
  validateWorldResources(resources);
  if (!requested?.trim()) return;
  const expected = requested.trim();
  if (expected !== "web" && expected !== "electron") throw new Error(`Unknown app surface selection: ${expected}`);
  const appSurfaces = resources.surfaces.filter(surface => surface !== "web");
  const required = expected === "web" ? "appWeb" : "desktop";
  if (appSurfaces.length === 0 || appSurfaces.some(surface => surface !== required)) {
    throw new Error(`Surface selection ${expected} conflicts with declared world surfaces [${resources.surfaces.join(", ")}]. Select a matching world instead.`);
  }
}

export function requireWorldResource(resources: WorldResources | undefined, resource: WorldSurface | WorldService): void {
  // Explicit bounded migration: undeclared legacy worlds remain labelled as such.
  if (resources === undefined) return;
  validateWorldResources(resources);
  const declared: readonly string[] = [...resources.surfaces, ...resources.services];
  if (!declared.includes(resource)) {
    throw new Error(`Undeclared world resource ${resource}: refused before launch. Declare it in spec.world resources.`);
  }
}

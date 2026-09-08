// Tab-scoped navigation intent, never a credential or a persisted membership flag.
export const SETUP_CONTINUATION_KEY = "openwork.den.setup-continuation";
export type SetupContinuation = {
  userId: string | null;
  desktopScheme: "openwork" | "opencoworker" | null;
  setup: { organizationId: string | null; route: string } | null;
  at: number;
};

export function parseSetupContinuation(raw: string | null): SetupContinuation | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null
      || !("userId" in value) || !(value.userId === null || typeof value.userId === "string")
      || !("desktopScheme" in value) || !(value.desktopScheme === null || value.desktopScheme === "openwork" || value.desktopScheme === "opencoworker")
      || !("at" in value) || typeof value.at !== "number" || !Number.isFinite(value.at)
      || value.at > Date.now() || Date.now() - value.at > 24 * 60 * 60 * 1000
      || !("setup" in value)) return null;
    const setup = value.setup;
    let pending: SetupContinuation["setup"] = null;
    if (setup !== null) {
      if (typeof setup !== "object"
      || !("organizationId" in setup) || !(setup.organizationId === null || typeof setup.organizationId === "string")
      || !("route" in setup) || typeof setup.route !== "string"
      || !["/organization", "/dashboard/onboarding/people", "/dashboard/onboarding/tools", "/dashboard/onboarding"].includes(setup.route)
      || !value.userId) return null;
      pending = { organizationId: setup.organizationId, route: setup.route };
    }
    return { userId: value.userId, desktopScheme: value.desktopScheme, at: value.at, setup: pending };
  } catch {
    return null;
  }
}

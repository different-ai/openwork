/** @jsxImportSource react */
import type { ReactNode } from "react";
import { SecretRevealProvider } from "@/components/secret-field";
import { useOrgFeature } from "./use-org-feature";

/**
 * Lets every SecretField offer "Show while typing" when the signed-in
 * organization has `secureSecretFields`. Signed out, unreachable or missing
 * means off, so fields stay plain masked inputs.
 */
export function SecretRevealFeatureProvider({ children }: { children: ReactNode }) {
  const enabled = useOrgFeature("secureSecretFields");
  return <SecretRevealProvider enabled={enabled}>{children}</SecretRevealProvider>;
}

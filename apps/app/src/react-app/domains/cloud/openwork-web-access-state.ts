import type { DenOpenWorkWebAccessSource } from "../../../app/lib/den";

export type OpenWorkWebAccessCheck = {
  scope: string;
  state: "granted" | "denied" | "error";
  accessSource: DenOpenWorkWebAccessSource;
};

export type OpenWorkWebAccessGateState = "inactive" | "checking" | "granted" | "denied" | "error";

export function resolveOpenWorkWebAccessGateState(input: {
  gatewayMode: boolean;
  authStatus: "checking" | "signed_in" | "unavailable" | "signed_out";
  authToken: string;
  organizationId: string;
  verifiedIdentity: { principalId: string; organizationId: string } | null;
  expectedScope: string | null;
  check: OpenWorkWebAccessCheck | null;
}): OpenWorkWebAccessGateState {
  if (!input.gatewayMode || !input.authToken || !input.organizationId) return "inactive";
  if (input.authStatus === "unavailable") return "error";
  if (input.authStatus !== "signed_in") return "checking";
  if (
    !input.verifiedIdentity
    || input.verifiedIdentity.organizationId !== input.organizationId
    || !input.expectedScope
  ) {
    return "checking";
  }
  if (!input.check || input.check.scope !== input.expectedScope) return "checking";
  return input.check.state;
}

import { AUTO_PROVIDER_ID } from "@/react-app/domains/models/model-catalog";

export const ORG_OPENWORK_MODELS_PROVIDER_ID = "openwork";

export const OPENWORK_MODELS_PROVIDER_IDS: readonly string[] = [ORG_OPENWORK_MODELS_PROVIDER_ID, AUTO_PROVIDER_ID];

export type OpenWorkModelsRowInput = {
  fromOrganization: boolean;
  managedByOrganization: boolean;
  isOrganizationAdmin: boolean;
  disabledProviders: readonly string[];
};

export type OpenWorkModelsRowPlan = {
  showDeviceRow: boolean;
  orgRowToggle: boolean;
  orgRowManaged: boolean;
  orgTurnedOff: boolean;
  clearStaleTurnOff: boolean;
  hideFromDisabledList: ReadonlySet<string>;
};

export function planOpenWorkModelsRow(input: OpenWorkModelsRowInput): OpenWorkModelsRowPlan {
  const personDecides = !input.managedByOrganization || input.isOrganizationAdmin;
  const savedTurnOff = input.disabledProviders.includes(ORG_OPENWORK_MODELS_PROVIDER_ID);
  return {
    showDeviceRow: !input.fromOrganization,
    orgRowToggle: input.fromOrganization && personDecides,
    orgRowManaged: input.fromOrganization && !personDecides,
    orgTurnedOff: input.fromOrganization && personDecides && savedTurnOff,
    clearStaleTurnOff: input.fromOrganization && !personDecides && savedTurnOff,
    hideFromDisabledList: new Set(OPENWORK_MODELS_PROVIDER_IDS),
  };
}

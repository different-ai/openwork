import { AUTO_PROVIDER_ID } from "@/react-app/domains/models/model-catalog";

/** Runtime id of OpenWork Models paid for by the organization (Den `source: "openwork"`). */
export const ORG_OPENWORK_MODELS_PROVIDER_ID = "openwork";

/** Both runtime ids that are shown to people as "OpenWork Models". */
export const OPENWORK_MODELS_PROVIDER_IDS: readonly string[] = [ORG_OPENWORK_MODELS_PROVIDER_ID, AUTO_PROVIDER_ID];

export type OpenWorkModelsRowInput = {
  /** `singleOpenWorkModelsRow` is on. Off keeps the previous rows exactly. */
  enabled: boolean;
  /** The organization includes OpenWork Models for this member. */
  fromOrganization: boolean;
  /**
   * The organization manages which models people use: Model access is "Only
   * models you provide" (`allowCustomProviders: false` for this person).
   */
  managedByOrganization: boolean;
  /** This person is an owner or admin of the organization. */
  isOrganizationAdmin: boolean;
  disabledProviders: readonly string[];
};

export type OpenWorkModelsRowPlan = {
  /** Show the free on-device "OpenWork Models" row (Settings and Connect a provider). */
  showDeviceRow: boolean;
  /** The organization's OpenWork Models row gets Turn off / Turn on. */
  orgRowToggle: boolean;
  /** The organization's row says it is managed by the organization, with no Turn off. */
  orgRowManaged: boolean;
  /** The organization's OpenWork Models is turned off on this device. */
  orgTurnedOff: boolean;
  /**
   * A turn-off saved on this device no longer applies: the organization now
   * manages models and this person is not an admin, so it is turned back on.
   */
  clearStaleTurnOff: boolean;
  /** Ids left out of the "turned off" provider list: the OpenWork Models row already shows their state. */
  hideFromDisabledList: ReadonlySet<string>;
};

/**
 * OpenWork Models is listed once: by the organization when it pays for it,
 * else as the free on-device row.
 *
 * Who decides whether the organization's OpenWork Models is on for a device:
 * - the person, when the organization does not manage models;
 * - only admins, when it does (Model access "Only models you provide").
 *   Admins keep Turn off; members see that their organization manages it.
 */
export function planOpenWorkModelsRow(input: OpenWorkModelsRowInput): OpenWorkModelsRowPlan {
  if (!input.enabled) {
    return { showDeviceRow: true, orgRowToggle: false, orgRowManaged: false, orgTurnedOff: false, clearStaleTurnOff: false, hideFromDisabledList: new Set() };
  }
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

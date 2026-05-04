import type { DenSettings, DenUser } from "./den";

export const denSessionUpdatedEvent = "openwork-den-session-updated";
export const denSettingsChangedEvent = "openwork-den-settings-changed";

export type DenSessionUpdatedDetail = {
  status?: "success" | "error";
  baseUrl?: string | null;
  token?: string | null;
  user?: DenUser | null;
  email?: string | null;
  message?: string | null;
};

export function dispatchDenSessionUpdated(detail: DenSessionUpdatedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSessionUpdatedDetail>(denSessionUpdatedEvent, {
      detail,
    }),
  );
}

export type DenSettingsChangedDetail = {
  settings: DenSettings;
};

export function dispatchDenSettingsChanged(detail: DenSettingsChangedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSettingsChangedDetail>(denSettingsChangedEvent, {
      detail,
    }),
  );
}

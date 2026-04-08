import type { DenUser } from "./den";

export const denSessionUpdatedEvent = "openwork-den-session-updated";

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

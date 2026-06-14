/**
 * Global DOM event fired when new providers become available in the
 * workspace — regardless of whether they came from cloud sync, local
 * config changes, or manual setup.
 *
 * Listeners (e.g. the global NewProvidersListener) should use this to
 * surface a notification-center entry.
 */
export const newProvidersEvent = "openwork-new-providers-available";

export type NewProviderInfo = {
  id: string;
  name: string;
  providerId: string;
  firstModelId?: string;
  firstModelName?: string;
};

export type NewProvidersEventDetail = {
  providers: NewProviderInfo[];
  newProviderCount?: number;
  newModelCount?: number;
  /** Where the change originated. "sign_in" is suppressed by the toast
   *  because the onboarding page handles first-time notification. */
  source: "cloud_sync" | "local_config" | "models_refresh" | "sign_in";
};

export function dispatchNewProviders(detail: NewProvidersEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<NewProvidersEventDetail>(newProvidersEvent, { detail }),
  );
}

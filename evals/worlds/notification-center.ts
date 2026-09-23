import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { archiveSessions } from "./session-shell.ts";

/** Real provider-sync payload shape the app dispatches on `openwork-new-providers-available`. */
export interface SyncedProvider {
  id: string;
  name: string;
  providerId: string;
}

/**
 * Archive-capable desktop plus the two background signals the notification
 * center contract distinguishes: a user-action confirmation (archive toast)
 * and a background event (provider sync landing in the center).
 */
export async function notificationCenter(seed: Seed) {
  const world = await archiveSessions(seed);
  return {
    ...world,
    /** Fire the same window event the provider sync dispatches after sign-in or a config change. */
    providerSync: (providers: SyncedProvider[]) => seed.evalIn(world.app, browserScript((providers) => {
      window.dispatchEvent(new CustomEvent("openwork-new-providers-available", {
        detail: { providers, newProviderCount: providers.length, newModelCount: 0, source: "cloud_sync" },
      }));
      return providers.length;
    }, [providers])),
    /** The accessible name carries the count; the visible indicator is a dot. */
    bell: () => seed.evalIn(world.app, () => {
      const button = document.querySelector<HTMLButtonElement>('[data-notification-bell]');
      return { label: button?.getAttribute("aria-label") ?? null, unread: Boolean(button?.querySelector("[data-notification-unread]")) };
    }),
  };
}

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
    /** The sidebar bell's accessible name carries the unread count; the badge is its visible twin. */
    bell: () => seed.evalIn(world.app, () => {
      const button = document.querySelector<HTMLButtonElement>('button[data-sidebar="menu-button"][aria-label^="Notifications"]');
      const badge = button?.querySelector("span.rounded-full");
      return { label: button?.getAttribute("aria-label") ?? null, badge: badge?.textContent?.trim() ?? null };
    }),
  };
}

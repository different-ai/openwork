import type { GatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { getLibraryRoute, getYourConnectionsRoute } from "../../../_lib/den-org";
import type { LibraryItem } from "../../_components/library-data";
import type { LibraryModelProvider } from "../../_components/library-models";

export const KEY_EXPIRY_WARNING_DAYS = 14;

export type MemberHomeNeed =
  | { kind: "connection"; id: string; name: string; serviceUrl: string; href: string }
  | { kind: "models"; id: string; name: string; iconSlug: string; href: string }
  | { kind: "key"; id: string; name: string; prefix: string; daysLeft: number };

export function memberHomeNeeds(input: {
  orgSlug: string | null;
  library: readonly LibraryItem[];
  providers: readonly Pick<LibraryModelProvider, "id" | "name" | "iconSlug" | "state">[];
  apiKeys: readonly GatewayApiKey[];
  keysEnabled: boolean;
  now: number;
}): MemberHomeNeed[] {
  const connections = input.library.flatMap((item): MemberHomeNeed[] => item.type === "connection" && item.state === "needs_signin"
    ? [{ kind: "connection", id: item.id, name: item.name, serviceUrl: item.url, href: `${getYourConnectionsRoute(input.orgSlug)}?connectionId=${encodeURIComponent(item.id)}` }]
    : []);
  const models = input.providers.flatMap((provider): MemberHomeNeed[] => provider.state === "needs_signin"
    ? [{ kind: "models", id: provider.id, name: provider.name, iconSlug: provider.iconSlug, href: `${getLibraryRoute(input.orgSlug)}?show=models` }]
    : []);
  const keys = input.keysEnabled
    ? input.apiKeys.flatMap((apiKey): MemberHomeNeed[] => {
        const daysLeft = keyDaysLeft(apiKey.expiresAt, input.now);
        return daysLeft === null || daysLeft > KEY_EXPIRY_WARNING_DAYS
          ? []
          : [{ kind: "key", id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, daysLeft }];
      })
    : [];
  return [...connections, ...models, ...keys];
}

export function keyDaysLeft(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const time = new Date(expiresAt).getTime();
  if (Number.isNaN(time) || time <= now) return null;
  return Math.ceil((time - now) / 86_400_000);
}

export function keyExpiresIn(daysLeft: number): string {
  return daysLeft <= 1 ? "expires tomorrow" : `expires in ${daysLeft} days`;
}

export function memberHomeState(orgName: string, needs: number): string {
  if (needs === 0) return orgName;
  return `${needs} ${needs === 1 ? "thing needs" : "things need"} you`;
}

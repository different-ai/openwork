import type { Seed } from "@openwork/env";
import { remoteSessionRegistration } from "./remote-session-registration.ts";
import { object, records, remoteSessionGateway, type GatewayListener } from "./fixtures/remote-session-gateway.ts";

export { object, records, string, SUBSCRIPTION_ID_META_KEY } from "./fixtures/remote-session-gateway.ts";
export { WORKSPACE_ID } from "./remote-session-registration.ts";
export type { GatewayListener } from "./fixtures/remote-session-gateway.ts";

/** Authenticated Den + real database + actual SDK transport; synthetic runner callbacks, no engine/model. */
export async function remoteSessionEvents(seed: Seed) {
  const registration = await remoteSessionRegistration(seed);
  const other = registration.den.members.other;
  if (!other) throw new Error("Missing negative receipt member");
  const gateway = remoteSessionGateway({
    owner: { session: registration.den.admin, organizationId: registration.organizationId },
    otherMember: { session: other, organizationId: registration.organizationId },
    otherOrg: { session: registration.den.admin, organizationId: registration.otherOrganizationId },
  });
  const listeners: GatewayListener[] = [];
  return {
    ...registration,
    rpc: gateway.rpc,
    async eventsFeature() {
      const result = await registration.api("owner", "/v1/admin/features");
      if (result.status !== 200) throw new Error(`Events feature inventory HTTP ${result.status}`);
      const feature = records(object(result.body).features).find(item => item.key === "remoteSessionEvents");
      if (!feature) throw new Error("Missing receipt events rollout");
      return feature;
    },
    async eventsRollout(enabled: boolean, killed = false) {
      return registration.api("owner", "/v1/admin/features/remoteSessionEvents", "PUT", { enabled, killed });
    },
    async listen(persona: string, uri: string) {
      const listener = await gateway.listen(persona, { notifications: { resourceSubscriptions: [uri] } });
      listeners.push(listener);
      return listener;
    },
    async [Symbol.asyncDispose]() {
      try { await Promise.all(listeners.map(listener => listener.close())); }
      finally { await registration[Symbol.asyncDispose](); }
    },
  };
}

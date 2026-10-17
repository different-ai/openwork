/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { createOpenworkServerClient, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature";
import { resolveOpenworkConnection } from "./openwork-connection";

/**
 * Retirement removes the invitation, consent and manual engine controls, not
 * the host-owned rollout. Older desktop profiles still need policy forwarding;
 * only explicitly v2-only hosted runtimes retire rollback.
 */
export function EngineMigrationOverlay() {
  const forceUpgrade = useOrgFeatureState("engineV2ForceUpgrade", { desktopOnly: true });
  const policyWrites = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!isDesktopRuntime() || !forceUpgrade.ready) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    let client: OpenworkServerClient | null = null;
    let applied = false;
    let previousEngine: boolean | null = null;
    const sync = async () => {
      try {
        if (!client) {
          const connection = await resolveOpenworkConnection();
          if (cancelled) return;
          if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) throw new Error("Local host is not ready");
          client = createOpenworkServerClient({
            baseUrl: connection.normalizedBaseUrl,
            token: connection.resolvedToken,
            hostToken: connection.resolvedHostToken,
          });
        }
        const currentClient = client;
        // Serialize off after any older in-flight on write. A stale response
        // must not refresh routing after the current policy has changed.
        const write = applied ? null : policyWrites.current.then(() =>
          cancelled ? null : currentClient.setEngineV2ForcePolicy({ upgrade: forceUpgrade.enabled }));
        if (write) policyWrites.current = write.then(() => {}, () => {});
        const status = write ? await write : await currentClient.getEngineV2PreviewStatus();
        if (cancelled || !status) return;
        applied = true;
        failures = 0;
        const engine = status.enabled && status.chatRouting;
        if ((previousEngine !== null && engine !== previousEngine)
          || (previousEngine === null && (status.engineForced || status.engineOrigin === "reverted"))) {
          window.dispatchEvent(new CustomEvent("openwork-engine-changed"));
        }
        previousEngine = engine;
        if (forceUpgrade.enabled || status.engineForced === true || status.forceUpgradePending === true) {
          timer = window.setTimeout(() => void sync(), 1_000);
        }
      } catch {
        // Migration retries and engine switching belong exclusively to the host.
        failures += 1;
        if (!cancelled && failures < 30) {
          client = null;
          applied = false;
          timer = window.setTimeout(() => void sync(), Math.min(30_000, 2_000 * 2 ** (failures - 1)));
        }
      }
    };
    void sync();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [forceUpgrade.ready, forceUpgrade.enabled]);
  return null;
}

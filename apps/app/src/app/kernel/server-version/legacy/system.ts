import type {
  OpenworkServerCapabilities,
  OpenworkRuntimeSnapshot,
  OpenworkServerDiagnostics,
} from "../../../lib/openwork-server";
import { createOpenworkServerClient } from "../../../lib/openwork-server";
import type { ServerTarget } from "../types";

function createLegacyClient(target: ServerTarget) {
  return createOpenworkServerClient({
    baseUrl: target.baseUrl,
    token: target.token,
    hostToken: target.hostToken,
  });
}

export async function fetchLegacySystemHealth(target: ServerTarget) {
  return createLegacyClient(target).health();
}

export async function fetchLegacyCapabilities(target: ServerTarget): Promise<OpenworkServerCapabilities> {
  return createLegacyClient(target).capabilities();
}

export async function fetchLegacySystemStatus(target: ServerTarget): Promise<{
  diagnostics: OpenworkServerDiagnostics;
  runtimeVersions: OpenworkRuntimeSnapshot | null;
}> {
  const client = createLegacyClient(target);
  const [diagnostics, runtimeVersions] = await Promise.all([
    client.status(),
    client.runtimeVersions().catch(() => null),
  ]);
  return { diagnostics, runtimeVersions };
}

import { mkdir } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** Real Desktop renderer in headless Chrome, real Den and disposable data. No Electron window or provider credentials. */
export async function remoteDevicesDesktopWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Devices workspace", admin: { name: "Avery Owner" }, members: { teammate: { name: "Riley Member" } } },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { remoteDevices: true });
  const report = await seed.api(den.admin, "/v1/remote-devices/this-computer", {
    method: "PUT", body: JSON.stringify({
      installId: "devices-desktop-proof-install", label: "Avery's MacBook", platform: "darwin", appVersion: "1.5.0",
      computerUse: { enabled: true, remoteEnabled: false, selectedId: "this-mac", permissions: { accessibility: true, screenRecording: false },
        computers: [{ id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off" }] },
    }),
  });
  if (!report.response.ok) throw new Error(`Desktop report failed: ${report.response.status} ${report.text}`);
  const shared = await seed.api(den.admin, "/v1/remote-devices", { method: "POST", body: JSON.stringify({
    label: "Team Mac sandbox", provider: "mac_host", platform: "darwin", externalId: "local:team-design", shared: true,
  }) });
  if (!shared.response.ok) throw new Error(`Shared sandbox failed: ${shared.response.status} ${shared.text}`);
  const workspacePath = seed.tmpPath("remote-devices-desktop");
  await mkdir(workspacePath, { recursive: true });
  const { app } = await signedInAppWeb(seed, { den, webPort, workspacePath, name: "remote-devices-desktop", headless: true, engine: "v2" });
  return {
    app,
    settingsUrl: `${app.webUrl}/settings/devices`,
    async setEnabled(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { remoteDevices: enabled } }) });
      if (!result.response.ok) throw new Error(`Changing Devices failed: ${result.response.status}`);
    },
    async memberList() {
      const result = await seed.api(den.members.teammate, "/v1/remote-devices");
      if (!result.response.ok) throw new Error(`Teammate devices failed: ${result.response.status}`);
      return result.body;
    },
  };
}

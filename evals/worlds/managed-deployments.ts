import { createOrg, type Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { enableOrganizationCapabilities } from "./dashboards.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real Den on the cloud deployment with a published (fixture) AWS installer
 * release, one workspace with deployments turned on, one with them off, and a
 * member. No AWS account is touched: the release URLs are never fetched by Den.
 */
export async function managedDeployments(seed: Seed) {
  const stamp = Date.now();
  const names = { enabled: `Deployments workspace ${stamp}`, disabled: `Deployments off ${stamp}` };
  const den = await seed.den({
    env: {
      DEN_DEPLOYMENT: "cloud", DEN_ORG_MODE: "multi_org",
      DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL: "https://releases.example.test/aws/0.18.57/cloudformation.json",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL: "https://releases.example.test/aws/0.18.57/bundle.tar.gz",
      DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256: "a".repeat(64),
      DEN_MANAGED_DEPLOYMENT_AWS_VERSION: "0.18.57",
    },
    org: { name: names.enabled, admin: { name: "Deployment Owner" }, members: { member: { name: "Deployment Member" } } },
  });
  const enabledOrgId = await enableOrganizationCapabilities(seed, den.admin, { managedDeployments: true });
  const disabledOrg = await createOrg(den, names.disabled);
  const viewport = { width: 1440, height: 1000 };

  // Each browser gets its own Better Auth cookie session with its own active
  // workspace, so no step depends on the workspace switcher.
  async function signedInBrowser(person: DenSession, organizationId: string, startPath: string) {
    const browser = await seed.web({ den, startPath: "/", headless: true, viewport });
    const signedIn = await seed.api(person, "/api/auth/sign-in/email", {
      method: "POST", headers: { origin: den.ref.webUrl },
      body: JSON.stringify({ email: person.email, password: person.password }),
    });
    const cookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
    const separator = cookie.indexOf("=");
    if (!signedIn.response.ok || separator < 1) throw new Error(`Browser sign-in failed: HTTP ${signedIn.response.status}`);
    const applied = await browser.client.send("Network.setCookie", {
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
      url: den.ref.webUrl, path: "/", httpOnly: true, secure: new URL(den.ref.webUrl).protocol === "https:",
    });
    if (!isRecord(applied) || applied.success !== true) throw new Error("Could not install the browser session cookie.");
    const selected = await seed.api(person, "/api/auth/organization/set-active", {
      method: "POST", headers: { cookie, origin: den.ref.webUrl }, body: JSON.stringify({ organizationId }),
    });
    if (!selected.response.ok) throw new Error(`Workspace selection failed: HTTP ${selected.response.status}`);
    await browser.client.send("Page.navigate", { url: new URL(startPath, den.ref.webUrl).toString() });
    return browser;
  }

  const offWeb = await signedInBrowser(den.admin, disabledOrg.id, "/dashboard/deployments");
  const web = await signedInBrowser(den.admin, enabledOrgId, "/dashboard/deployments");
  const memberWeb = await signedInBrowser(den.members.member, enabledOrgId, "/dashboard");
  return {
    den, web, offWeb, memberWeb, names, enabledOrgId, disabledOrgId: disabledOrg.id, baseUrl: den.ref.webUrl,
    async [Symbol.asyncDispose]() { await disabledOrg[Symbol.asyncDispose](); },
  };
}

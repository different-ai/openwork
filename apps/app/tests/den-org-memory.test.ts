import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  readRememberedDenOrganization,
  rememberDenOrganization,
  restoreRememberedDenOrganization,
} from "../src/app/lib/den-org-memory";
import { resolveHandoffOrgPlan } from "../src/app/lib/den-sign-in-intent";

const scope = { serverKey: "https://den.example.test", userId: "user-a" };
const firstOrg = { id: "org-a", name: "First workspace", slug: "first", role: "member" };
const lastOrg = { id: "org-b", name: "Last workspace", slug: "last", role: "member" };

function memoryClient(features: Record<string, boolean> = {}) {
  return {
    listOrgs: mock(async () => ({
      orgs: [firstOrg, lastOrg],
      activeOrgId: firstOrg.id,
      activeOrgSlug: firstOrg.slug,
      defaultOrgId: firstOrg.id,
    })),
    getOrgFeatures: mock(async (_organizationId: string) => features),
    setActiveOrganization: mock(async (_input: { organizationId?: string | null }) => {}),
  };
}

beforeEach(() => GlobalRegistrator.register({ url: "http://localhost:5173/" }));
afterEach(async () => GlobalRegistrator.unregister());

describe("last organization preference", () => {
  test("keeps only an org ID separately from session credentials", () => {
    rememberDenOrganization(scope, lastOrg.id);
    expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);
    const key = window.localStorage.key(0);
    expect(key).not.toBeNull();
    expect(window.localStorage.getItem(key ?? "")).toBe(lastOrg.id);
    expect(window.localStorage.length).toBe(1);
  });

  test("isolates different accounts and control planes", () => {
    rememberDenOrganization(scope, lastOrg.id);
    expect(readRememberedDenOrganization({ ...scope, userId: "user-b" })).toBeNull();
    expect(readRememberedDenOrganization({ ...scope, serverKey: "https://other.example.test" })).toBeNull();
    rememberDenOrganization({ ...scope, userId: "user-b" }, firstOrg.id);
    expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);
  });

  test("does not record a preference without a verified identity and origin", () => {
    rememberDenOrganization({ ...scope, userId: " " }, lastOrg.id);
    rememberDenOrganization({ ...scope, serverKey: null }, lastOrg.id);
    rememberDenOrganization(scope, " ");
    expect(window.localStorage.length).toBe(0);
  });

  test("unavailable storage is non-fatal", () => {
    // Happy DOM proxies Storage properties, so replace the accessor rather
    // than spying on methods that its proxy would continue to dispatch.
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("storage blocked"); },
    });
    expect(() => rememberDenOrganization(scope, lastOrg.id)).not.toThrow();
    expect(readRememberedDenOrganization(scope)).toBeNull();
  });
});

describe("returning account restoration", () => {
  test("validates current membership, then syncs the last org rather than the exchange default", async () => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient();
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => true })).toEqual(lastOrg);
    expect(client.getOrgFeatures).not.toHaveBeenCalled();
    expect(client.setActiveOrganization).toHaveBeenCalledWith({ organizationId: lastOrg.id });
  });

  test("a first-time or different account keeps the chooser without fetching an org", async () => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient();
    expect(await restoreRememberedDenOrganization({ ...scope, userId: "user-b", client, isCurrent: () => true })).toBeNull();
    expect(client.listOrgs).not.toHaveBeenCalled();
    expect(client.setActiveOrganization).not.toHaveBeenCalled();
  });

  test.each([{}, { rememberLastOrganization: false }])("legacy rollout metadata cannot disable restoration (%j)", async (features) => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient(features);
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => true })).toEqual(lastOrg);
    expect(client.getOrgFeatures).not.toHaveBeenCalled();
    expect(client.setActiveOrganization).toHaveBeenCalledWith({ organizationId: lastOrg.id });
  });

  test("removed membership cannot restore the remembered org", async () => {
    rememberDenOrganization(scope, "removed-org");
    const client = memoryClient();
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => true })).toBeNull();
    expect(client.getOrgFeatures).not.toHaveBeenCalled();
    expect(client.setActiveOrganization).not.toHaveBeenCalled();
  });

  test.each(["directory", "sync"])("a %s failure keeps the chooser and preference", async (stage) => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient();
    const reject = async (): Promise<never> => { throw new Error("temporarily unavailable"); };
    if (stage === "directory") client.listOrgs.mockImplementation(reject);
    if (stage === "sync") client.setActiveOrganization.mockImplementation(reject);
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => true })).toBeNull();
    expect(readRememberedDenOrganization(scope)).toBe(lastOrg.id);
  });

  test("a newer handoff prevents an old restore from changing the session", async () => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient();
    let current = true;
    client.listOrgs.mockImplementation(async () => {
      current = false;
      return { orgs: [firstOrg, lastOrg], activeOrgId: firstOrg.id, activeOrgSlug: firstOrg.slug, defaultOrgId: firstOrg.id };
    });
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => current })).toBeNull();
    expect(client.setActiveOrganization).not.toHaveBeenCalled();
  });

  test("a restore superseded during server sync is not published locally", async () => {
    rememberDenOrganization(scope, lastOrg.id);
    const client = memoryClient();
    let current = true;
    client.setActiveOrganization.mockImplementation(async () => { current = false; });
    expect(await restoreRememberedDenOrganization({ ...scope, client, isCurrent: () => current })).toBeNull();
  });
});

describe("handoff organization priority", () => {
  const base = { explicitActiveOrg: null, exchangeOrganization: firstOrg, desktopInitiated: true };

  test("restores a verified remembered choice on desktop sign-in", () => {
    expect(resolveHandoffOrgPlan({ ...base, rememberedOrganization: lastOrg })).toEqual({ kind: "commit", organization: lastOrg });
  });

  test("an explicit invite or installation org wins over memory", () => {
    expect(resolveHandoffOrgPlan({ ...base, explicitActiveOrg: firstOrg, rememberedOrganization: lastOrg })).toEqual({ kind: "commit", organization: firstOrg });
  });

  test("a remote handoff keeps its remotely selected org", () => {
    expect(resolveHandoffOrgPlan({ ...base, desktopInitiated: false, rememberedOrganization: lastOrg })).toEqual({ kind: "commit", organization: firstOrg });
  });

  test("without verified memory the exchange default remains only a suggestion", () => {
    expect(resolveHandoffOrgPlan(base)).toEqual({ kind: "await-user-selection", suggestion: firstOrg });
  });
});

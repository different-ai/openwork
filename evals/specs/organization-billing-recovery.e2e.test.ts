import { chrome } from "@openwork/hosts";
import { callFunctionOnSurface, evaluateOnSurface, navigate } from "@openwork/cdp";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { createOrg, eventually, needs, queryDenDatabase, server, test } from "@openwork/testkit";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The database creates synthetic billing states only; every claim crosses the real Den API.
test("organization billing survives selection and blocks destructive deletion", { timeout: 420_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", env: ["OPENWORK_EVAL_MYSQL_URL"] });
  await using den = await server({ place, web: true, org: { name: "Billing Recovery", members: { observer: { name: "Synthetic Member" } } }, env: {
    STRIPE_SECRET_KEY: "", STRIPE_OPENWORK_WEB_PRICE_ID: "price_synthetic_web", POLAR_ACCESS_TOKEN: "", LINEAR_API_KEY: "", DEN_OPENWORK_WEB_ENABLED: "true",
  } });
  if (!den.database) throw new Error("This journey requires its own synthetic database");
  const databaseUrl = den.database.url;
  const subscribed = await createOrg(den, "Subscribed Workspace");
  await using empty = await createOrg(den, "Empty Workspace");
  const request = (path: string, orgId: string, method = "GET", body?: unknown) => denFetch(den.admin, path, {
    method,
    headers: { authorization: `Bearer ${den.admin.token}`, ...(path === "/v1/me/orgs" ? {} : { "x-openwork-org-id": orgId }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  try {
    await queryDenDatabase(databaseUrl,
      "INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, quantity, current_period_end, cancel_at_period_end) VALUES (?, ?, 'web', 'active', 'cus_synthetic_billing', 'sub_synthetic_billing', 'price_synthetic_web', 1, DATE_ADD(NOW(), INTERVAL 30 DAY), true)",
      ["osub_00000000000000000000000001", subscribed.id]);

    const blocked = await request("/v1/org", subscribed.id, "DELETE");
    evidence.recordAssertionEvidence("Scheduled cancellation does not permit deletion of paid access", `DELETE returned HTTP ${blocked.response.status}; expected 409.`, blocked.response.status === 409);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "organization_has_subscriptions" });
    expect(record(blocked.body) && String(blocked.body.message)).toContain("Billing");

    for (const orgId of [empty.id, subscribed.id]) {
      const selected = await request("/v1/me/active-organization", orgId, "POST", { organizationId: orgId });
      expect(selected.response.ok).toBe(true);
      const directory = await request("/v1/me/orgs", orgId);
      expect(directory.response.ok).toBe(true);
      const orgs = record(directory.body) && Array.isArray(directory.body.orgs) ? directory.body.orgs.filter(record) : [];
      expect(orgs.find((org) => org.id === subscribed.id)).toMatchObject({ name: "Subscribed Workspace", hasSubscriptions: true });
      expect(orgs.find((org) => org.id === empty.id)).toMatchObject({ hasSubscriptions: false });
      const billing = await request("/v1/billing/web", orgId);
      expect(billing.response.ok).toBe(true);
      const stripe = record(billing.body) && record(billing.body.billing) ? billing.body.billing.stripe : null;
      const web = record(stripe) ? stripe.web : null;
      expect(record(web) && web.hasEligibleSubscription).toBe(orgId === subscribed.id);
    }
    evidence.recordAssertionEvidence("Switching organizations exposes the subscribed workspace without transferring its access", "Both selections list Subscribed Workspace with subscriptions and Empty Workspace without; only the subscribed organization retains paid Web access.", true);

    const outsider = await denFetch(den.members.observer, "/v1/me/orgs", {
      headers: { authorization: `Bearer ${den.members.observer.token}` }, signal: AbortSignal.timeout(15_000),
    });
    expect(outsider.response.ok).toBe(true);
    const outsiderOrgs = record(outsider.body) && Array.isArray(outsider.body.orgs) ? outsider.body.orgs.filter(record) : [];
    expect(outsiderOrgs.some((org) => org.id === subscribed.id || org.id === empty.id)).toBe(false);
    const unauthorizedDelete = await denFetch(den.members.observer, "/v1/org", {
      method: "DELETE", headers: { authorization: `Bearer ${den.members.observer.token}`, "x-openwork-org-id": subscribed.id },
      signal: AbortSignal.timeout(15_000),
    });
    expect(unauthorizedDelete.response.status).toBe(404);
    evidence.recordAssertionEvidence("Billing discovery stays within the caller's organizations", "The unrelated member cannot discover either workspace or delete the subscribed workspace.", true);

    expect((await request("/v1/me/active-organization", empty.id, "POST", { organizationId: empty.id })).response.ok).toBe(true);
    await using browser = await chrome({ host: place.host(), startUrl: den.ref.webUrl, headless: true });
    await eventually(() => evaluateOnSurface(browser, "document.readyState"), { within: 30_000, until: (state) => state === "complete" });
    await callFunctionOnSurface(browser, `(token) => { localStorage.setItem("openwork:web:auth-token", token); return true; }`, [den.admin.token]);
    await navigate(browser.client, new URL("/dashboard/billing", den.ref.webUrl).toString());
    const emptyBilling = await eventually(() => evaluateOnSurface(browser, "document.body.innerText"), {
      within: 90_000, until: (text) => typeof text === "string" && text.includes("Organization subscriptions belong to Empty Workspace") && text.includes("Open Billing for Subscribed Workspace"),
    });
    expect(emptyBilling).not.toContain("Open Billing for Empty Workspace");
    const clicked = await evaluateOnSurface(browser, `(() => {
      const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent.includes("Open Billing for Subscribed Workspace"));
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    expect(clicked).toBe(true);
    const recovered = await eventually(() => evaluateOnSurface(browser, "document.body.innerText"), {
      within: 60_000, until: (text) => typeof text === "string" && text.includes("Organization subscriptions belong to Subscribed Workspace"),
    });
    expect(recovered).not.toContain("Organization subscriptions belong to Empty Workspace");
    expect(await evaluateOnSurface(browser, "location.pathname")).toBe("/dashboard/billing");
    evidence.recordAssertionEvidence("The Billing recovery button switches to the subscribed organization", "The browser starts on Empty Workspace Billing, shows Subscribed Workspace recovery, and clicking it renders Subscribed Workspace Billing without transferring access.", true);

    for (const type of ["seat", "inference", "web"]) {
      await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET type = ? WHERE organization_id = ?", [type, subscribed.id]);
      expect((await request("/v1/org", subscribed.id, "DELETE")).response.status).toBe(409);
    }
    evidence.recordAssertionEvidence("Every organization subscription product protects deletion", "Active seat, inference and web subscriptions each return 409.", true);

    for (const status of ["trialing", "past_due", "unpaid", "paused", "incomplete"]) {
      await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET status = ? WHERE organization_id = ?", [status, subscribed.id]);
      expect((await request("/v1/org", subscribed.id, "DELETE")).response.status).toBe(409);
    }
    evidence.recordAssertionEvidence("Unresolved subscriptions cannot be silently orphaned", "Trialing, past_due, unpaid, paused and incomplete subscriptions all return 409 on deletion.", true);

    await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET status = 'canceled', current_period_end = NOW(), ended_at = NOW() WHERE organization_id = ?", [subscribed.id]);
    expect((await request("/v1/org", subscribed.id, "DELETE")).response.status).toBe(200);
    expect((await request("/v1/org", empty.id)).response.status).toBe(200);
    const directory = await request("/v1/me/orgs", empty.id);
    const orgs = record(directory.body) && Array.isArray(directory.body.orgs) ? directory.body.orgs.filter(record) : [];
    expect(orgs.some((org) => org.id === subscribed.id)).toBe(false);
    expect(orgs.some((org) => org.id === empty.id)).toBe(true);
    evidence.recordAssertionEvidence("Ended subscriptions allow deletion without changing the other organization", "Deletion returns 200 after billing ends; the subscribed organization disappears while Empty Workspace remains accessible.", true);
  } finally {
    await queryDenDatabase(databaseUrl, "DELETE FROM org_subscriptions WHERE organization_id = ?", [subscribed.id]);
  }
});

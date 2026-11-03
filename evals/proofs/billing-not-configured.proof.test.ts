import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { billingNotConfiguredWorld } from "../worlds/billing-not-configured.ts";

const test = spec.world(billingNotConfiguredWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? Object.fromEntries(Object.entries(value))[key] : undefined;
}

test("an owner on a deployment that sells nothing sees what isn't sold and the alternative, never an error", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);

  await step("before: Subscribe on OpenWork Models used to answer internal_server_error; the same request now answers 503 billing_not_configured", async () => {
    await owner.see({ text: "OpenWork Models" }, { timeoutMs: 90_000 });
    const subscribe = await world.buy({ type: "inference" });
    expect(subscribe.status).toBe(503);
    expect(subscribe.body).toEqual({ error: "billing_not_configured", product: "inference", message: "OpenWork Models isn't sold on this deployment." });
    evidence.recordAssertionEvidence(
      "Subscribe is a configuration state, not a server error",
      `POST /v1/billing/stripe/checkout {type:"inference"} → ${subscribe.status} ${JSON.stringify(subscribe.body)}`,
      subscribe.status === 503 && field(subscribe.body, "error") === "billing_not_configured",
    );
  });

  await step("after: OpenWork Models says it isn't sold here, offers a team provider, and has no Subscribe", async () => {
    await owner.see({ testId: "models-not-sold" }, { text: /OpenWork Models isn't sold on this deployment\./, timeoutMs: 60_000 });
    await owner.see({ role: "link", label: "Add a team provider" });
    await owner.notSee({ role: "button", label: "Subscribe" });
    const notice = await probe.on(world.web).dom('[data-testid="models-not-sold"] [data-notice-tone]');
    const tone = notice.elements[0]?.text ?? "";
    evidence.recordAssertionEvidence(
      "Neutral lock with the alternative, no buy button",
      `notice: "${tone.replace(/\s+/g, " ").trim()}"; Subscribe button absent`,
      tone.includes("isn't sold on this deployment"),
    );
    await owner.screenshot();
  });

  await step("after: Billing lists each product as not sold on this deployment, with no buy button", async () => {
    await owner.navigate(world.url("/dashboard/billing"));
    await owner.see({ testId: "billing-summary-card" }, { text: /OpenWork Models isn't sold on this deployment\.[\s\S]*Not sold/, timeoutMs: 60_000 });
    await owner.see({ testId: "billing-ai-card" }, { text: /OpenWork Models isn't sold on this deployment\./ });
    await owner.notSee({ role: "button", label: "Add paid seats" });
    await owner.notSee({ role: "button", label: "View OpenWork Models" });
    const billing = await probe.api(world.owner, "/v1/billing");
    const plan = field(field(billing.body, "billing"), "plan");
    const plans = field(field(billing.body, "billing"), "plans");
    expect(billing.response.status).toBe(200);
    expect(field(field(plans, "team"), "available")).toBe(false);
    evidence.recordAssertionEvidence(
      "Billing reads as not sold, with honest people counts",
      `GET /v1/billing → plan ${JSON.stringify(plan)}; team available=${String(field(field(plans, "team"), "available"))}; enterprise available=${String(field(field(plans, "enterprise"), "available"))}`,
      field(field(plans, "team"), "available") === false && field(plan, "tier") === "free",
    );
    await owner.screenshot();
  });

  await step("every buy action answers 503 billing_not_configured with its product, none answers 500", async () => {
    await owner.see({ testId: "billing-plan-card" }, { text: /The Team plan isn't sold on this deployment\./ });
    const attempts = [
      { body: { type: "inference", returnTo: "desktop" }, product: "inference" },
      { body: { type: "seat" }, product: "seat" },
      { body: { type: "plan", plan: "team", addPeople: 1 }, product: "team" },
      { body: { type: "plan", plan: "enterprise" }, product: null },
    ] as const;
    const results: string[] = [];
    for (const attempt of attempts) {
      const result = await world.buy(attempt.body);
      results.push(`${JSON.stringify(attempt.body)} → ${result.status} ${String(field(result.body, "error"))}${field(result.body, "product") ? `/${String(field(result.body, "product"))}` : ""}`);
      expect(result.status).not.toBe(500);
      if (attempt.product) expect(result.body).toMatchObject({ error: "billing_not_configured", product: attempt.product });
      else expect(result.status).toBe(400); // Enterprise is never sold by card.
    }
    evidence.recordAssertionEvidence(
      "No configuration path returns 500",
      results.join("; "),
      results.every((line) => !line.includes("→ 500")),
    );
  });

  await step("Add a team provider opens AI providers", async () => {
    await owner.navigate(world.url("/dashboard/ai-gateway?tab=openwork-models"));
    await owner.click({ role: "link", label: "Add a team provider" });
    await owner.see({ testId: "ai-gateway-panel-ai-providers" }, { timeoutMs: 30_000 });
    const location = await probe.on(world.web).url();
    expect(new URL(location).searchParams.get("tab")).toBe("ai-providers");
    evidence.recordAssertionEvidence("The alternative leads to team providers", `landed on ${new URL(location).pathname}${new URL(location).search}`, new URL(location).searchParams.get("tab") === "ai-providers");
    await owner.screenshot();
  });
});

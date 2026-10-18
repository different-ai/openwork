import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerManagementLayout } from "../worlds/provider-management-layout.ts";

const test = spec.world(providerManagementLayout, {
  resources: { surfaces: ["web"], services: ["den"] }, timeout: 600_000,
});

const sections = '[data-testid="gateway-providers-section"], [data-testid="gateway-legacy-providers"]';

function layoutEnabled(body: unknown) {
  if (typeof body !== "object" || body === null || !("features" in body)) return false;
  const features = body.features;
  return typeof features === "object" && features !== null && "providerManagementLayout" in features && features.providerManagementLayout === true;
}

test("an owner compares gateway and legacy providers without losing either management flow", async ({ world, user, probe, step, evidence }) => {
  const providersUrl = world.url("/dashboard/ai-gateway?tab=ai-providers");
  const featuresUrl = world.url(`/admin/organizations/${world.orgId}/features`);
  // The flag-off screen is the untouched stacked layout: gateway rows, then the Legacy Providers section.
  async function originalLayout() {
    const rows = await probe.dom('[data-testid="gateway-provider-row"]');
    const legacy = await probe.dom('[data-testid="gateway-legacy-providers"]');
    const comparison = await probe.dom('[data-layout="comparison"]');
    const lastRow = rows.elements[rows.elements.length - 1];
    const legacyTop = legacy.elements[0]?.rect.top ?? -1;
    const stacked = comparison.elements.length === 0 && Boolean(lastRow) && legacyTop >= lastRow.rect.top + lastRow.rect.height && legacy.elements[0].text.includes("Legacy Providers");
    return { stacked, detail: `comparison layout present=${comparison.elements.length > 0}; gateway rows=${rows.elements.length}, last row bottom=${lastRow ? lastRow.rect.top + lastRow.rect.height : "none"}; Legacy Providers top=${legacyTop}` };
  }
  await step("before: the disabled rollout keeps legacy providers below the gateway list", async () => {
    await user.see({ text: "Shared gateway models" }, { timeoutMs: 60_000 });
    await user.see({ text: "Shared desktop credentials with a long provider name" });
    const original = await originalLayout();
    evidence.recordAssertionEvidence("The default remains the original stacked layout", original.detail, original.stacked);
    expect(original.stacked).toBe(true);
    await user.screenshot();
  });
  await step("after: enabling the rollout places clearly marked provider systems side by side", async () => {
    await user.navigate(featuresUrl);
    await user.see({ testId: "admin-capability-providerManagementLayout" });
    await user.click({ testId: "admin-capability-providerManagementLayout" });
    await user.see({ testId: "admin-capability-source-providerManagementLayout" }, { text: "Set for this organization" });
    await probe.eventually(() => probe.api(world.den.admin, "/v1/org"), { within: 10_000, until: (result) => layoutEnabled(result.body), label: "saved provider layout rollout" });
    await user.navigate(providersUrl);
    await user.see({ role: "heading", label: "AI Gateway providers" });
    await user.see({ role: "heading", label: "Bring your own key" });
    await user.see({ text: "Shared gateway models" });
    await user.see({ text: "Shared desktop credentials with a long provider name" });
    const layout = await probe.dom(sections);
    const [gateway, legacy] = layout.elements;
    const panels = await probe.dom('[data-layout="comparison"] section > div.rounded-2xl');
    const listsAligned = panels.elements.length === 2 && Math.abs(panels.elements[0].rect.top - panels.elements[1].rect.top) < 1;
    const sideBySide = Math.abs(gateway.rect.top - legacy.rect.top) < 2 && legacy.rect.left >= gateway.rect.left + gateway.rect.width && gateway.rect.width >= 460;
    evidence.recordAssertionEvidence("Both provider systems sit side by side with explicit New and Legacy labels, and their lists start on the same line", `${layout.elements.map((entry) => `${entry.text.slice(0, 40)}: x=${entry.rect.left}, width=${entry.rect.width}`).join("; ")}; list tops=${panels.elements.map((entry) => entry.rect.top).join(" / ")}`, sideBySide && listsAligned && gateway.text.includes("New") && legacy.text.includes("Legacy"));
    expect(sideBySide).toBe(true);
    expect(listsAligned).toBe(true);
    expect(gateway.text).toContain("New");
    expect(legacy.text).toContain("Legacy");
    await user.screenshot();
  });
  await step("the legacy distinction explains desktop key sharing and unavailable usage controls", async () => {
    await user.click({ text: "How legacy keys differ" });
    await user.see({ text: "Bring Your Own Key (Legacy System) providers send the API key directly to users’ desktop applications." });
    const details = await probe.dom('[data-testid="gateway-legacy-providers"] details[open]');
    const copy = details.elements[0]?.text ?? "";
    const accurate = copy.includes("Usage tracking and usage limit policies are not available") && copy.includes("use AI Gateway providers") && !copy.includes("section above");
    evidence.recordAssertionEvidence("Legacy limitations stay accurate in either layout", copy, accurate);
    expect(accurate).toBe(true);
    await user.screenshot();
  });
  await step("one filter narrows both lists without changing either", async () => {
    await user.type({ label: "Filter providers…" }, "desktop");
    await user.see({ text: "No AI Gateway providers match “desktop”." });
    await user.see({ text: "Shared desktop credentials with a long provider name" });
    const rows = await probe.dom('[data-testid="gateway-provider-open"], [data-testid="llm-provider-card"]');
    const narrowed = rows.elements.length === 1 && rows.elements[0].text.includes("Shared desktop credentials");
    await user.screenshot();
    await user.type({ label: "Filter providers…" }, "", { replace: true });
    await user.see({ text: "Shared gateway models" });
    const restored = await probe.dom('[data-testid="gateway-provider-open"], [data-testid="llm-provider-card"]');
    evidence.recordAssertionEvidence("Filtering hides rows in both columns and clearing it restores both", `"desktop" → ${rows.elements.length} row (${rows.elements.map((entry) => entry.text.slice(0, 40)).join("; ")}); cleared → ${restored.elements.length} rows`, narrowed && restored.elements.length === 2);
    expect(narrowed).toBe(true);
    expect(restored.elements).toHaveLength(2);
  });
  await step("after: both lists and their actions stack without overflow on tablet and phone", async () => {
    for (const width of [1000, 390]) {
      await user.resizeViewport({ width, height: 1000, deviceScaleFactor: 1 });
      await user.see({ text: "Shared gateway models" });
      await user.see({ text: "Shared desktop credentials with a long provider name" });
      const layout = await probe.dom(sections);
      const [gateway, legacy] = layout.elements;
      const controls = await probe.dom('[data-testid="gateway-provider-open"], [data-testid="gateway-provider-create"], [data-testid="legacy-provider-create"], [data-testid="llm-provider-card"]');
      const fits = controls.documentWidth <= controls.viewportWidth && controls.elements.every((entry) => entry.rect.left >= 0 && entry.rect.left + entry.rect.width <= width);
      expect(legacy.rect.top).toBeGreaterThanOrEqual(gateway.rect.top + gateway.rect.height);
      expect(fits).toBe(true);
      if (width === 390) evidence.recordAssertionEvidence("Provider lists stack and every management action fits a phone", `viewport=${width}; document=${controls.documentWidth}; actions=${controls.elements.length}; legacy top=${legacy.rect.top}`, fits && controls.elements.length === 4);
      await user.screenshot();
    }
  });
  await step("both existing management and creation destinations remain reachable", async () => {
    await user.click({ testId: "gateway-provider-open" });
    await user.see({ role: "heading", label: "Shared gateway models" }, { timeoutMs: 60_000 });
    await user.navigate(providersUrl);
    await user.click({ testId: "llm-provider-card" });
    await user.see({ role: "heading", label: "Shared desktop credentials with a long provider name" });
    await user.navigate(providersUrl);
    await user.click({ testId: "legacy-provider-create" });
    await user.see("Catalog provider");
    await user.navigate(providersUrl);
    await user.click({ testId: "gateway-provider-create" });
    await user.see({ role: "heading", label: "Add a provider" });
    const path = await probe.hash();
    evidence.recordAssertionEvidence("Gateway and legacy actions still open their original forms", `final creation route=${path}`, path.includes("/providers/new"));
    expect(path).toContain("/providers/new");
    await user.screenshot();
  });
  await step("turning the rollout off restores the original layout and retains both provider records", async () => {
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await user.navigate(featuresUrl);
    await user.click({ testId: "admin-capability-providerManagementLayout" });
    await user.see({ testId: "admin-capability-source-providerManagementLayout" }, { text: "Set for this organization" });
    await probe.eventually(() => probe.api(world.den.admin, "/v1/org"), { within: 10_000, until: (result) => !layoutEnabled(result.body), label: "disabled provider layout rollout" });
    await user.navigate(providersUrl);
    await user.see({ text: "Shared gateway models" });
    await user.see({ role: "heading", label: "Legacy Providers" });
    await user.see({ text: "Shared desktop credentials with a long provider name" });
    const original = await originalLayout();
    const rows = await probe.dom('[data-testid="gateway-provider-row"], [data-testid="llm-provider-card"]');
    const restored = original.stacked && rows.elements.length === 2;
    evidence.recordAssertionEvidence("Reverting changes presentation only, not saved providers", `${original.detail}; saved provider rows=${rows.elements.length}`, restored);
    expect(restored).toBe(true);
    await user.screenshot();
  });
});

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminPreviewFlagsWorld } from "../worlds/admin-preview-flags.ts";

const test = spec.world(adminPreviewFlagsWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const RETIRED = ["remoteComputers", "lowStorageWarning", "questionMinimize", "providerFilterSyncFix", "importOpencodeConnections", "gatewayOpenCodeSetup"];

test("a platform admin sees preview flags with their owner and expiry, and none that shipped", async ({ user, probe, step, evidence }) => {
  const text = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());

  await step("/admin lists Preview flags, each with an owner and the day its decision is due", async () => {
    await user.see({ testId: "admin-feature-sessionTree" }, { timeoutMs: 120_000 });
    const nav = await text('a[href="/admin/features"]');
    const heading = await text("h1");
    const owner = (await text('[data-testid="admin-feature-owner-sessionTree"]')).join(" ");
    const expires = (await text('[data-testid="admin-feature-expires-sessionTree"]')).join(" ");
    await user.screenshot();
    const ok = nav.includes("Preview flags") && heading.includes("Preview flags") && /^Owner @[A-Za-z0-9-]+/.test(owner) && /^Expires \S.*\d{4}$/.test(expires);
    evidence.recordAssertionEvidence("The page and its navigation entry are called Preview flags, and a row names its owner and expiry", `navigation: ${nav.join(", ")}; heading: ${heading.join(", ")}; owner line: ${owner}; expiry: ${expires}`, ok);
    expect(ok).toBe(true);
  });

  await step("previews that shipped are no longer switches", async () => {
    const listed = await Promise.all(RETIRED.map(async (key) => [key, (await text(`[data-testid="admin-feature-${key}"]`)).length] as const));
    const rows = (await text('[data-testid^="admin-feature-state-"]')).length;
    const ok = rows > 0 && listed.every(([, count]) => count === 0);
    evidence.recordAssertionEvidence("None of the six retired keys has a row", `rows listed: ${rows}; retired keys with a row: ${listed.filter(([, count]) => count > 0).map(([key]) => key).join(", ") || "none"}`, ok);
    expect(ok).toBe(true);
  });
});

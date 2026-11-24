import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { TRUEFOUNDRY_CHAT_MODELS, gatewayTrueFoundryModelsWorld } from "../worlds/gateway-truefoundry-models.ts";

const test = spec.world(gatewayTrueFoundryModelsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const WITHIN = 60_000;
const ALL = [...TRUEFOUNDRY_CHAT_MODELS].sort();
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_READY = '[data-testid="truefoundry-sync"]:not([disabled])';

test("OpenWork keeps TrueFoundry keys from piling up, and an admin can reset a person stuck at the token limit", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  /** Sync, once no other action on the page is still running. */
  const sync = async () => {
    await probe.eventually(() => probe.dom(SYNC_READY), { within: WITHIN, label: "Sync is ready", until: (dom) => dom.elements.length === 1 });
    await user.click({ testId: "truefoundry-sync" });
    await probe.eventually(() => probe.dom(SYNC_READY), { within: WITHIN, label: "the sync finished", until: (dom) => dom.elements.length === 1 });
  };
  const email = world.member.email.toLowerCase();

  await step("every key OpenWork creates expires in 90 days", async () => {
    const expirations = world.tenant.expirations();
    const days = expirations.map((value) => value ? Math.round((Date.parse(value) - Date.now()) / DAY_MS) : null);
    const ok = days.length > 0 && days.every((value) => value === 90);
    evidence.recordAssertionEvidence("Each token was created with a 90-day expirationDate", JSON.stringify({ expirations, days }), ok);
    expect(ok).toBe(true);
  });

  await step("keys are named after the person, so TrueFoundry admins can tell whose they are", async () => {
    const names = world.tenant.tokenNamesOf(email);
    const ok = names.length === 1 && names.every((name) => name.startsWith("openwork-member") && name.length <= 36 && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(name));
    evidence.recordAssertionEvidence("One key, named openwork-<email>-…, in TrueFoundry's name rules", JSON.stringify(names), ok);
    expect(ok).toBe(true);
  });

  await step("a sync deletes old OpenWork keys the person still holds, and never their own tokens", async () => {
    const current = world.tenant.tokenNamesOf(email);
    world.tenant.addOldToken(email, "openwork-0123456789ab");
    world.tenant.addOldToken(email, "my-notebook");
    await sync();
    await user.see({ text: /^Synced/ }, { timeoutMs: WITHIN });
    const names = world.tenant.tokenNamesOf(email);
    const expected = [...current, "my-notebook"].sort();
    evidence.recordAssertionEvidence("The lost OpenWork key is gone; their own token and current key remain", JSON.stringify(names), JSON.stringify(names) === JSON.stringify(expected));
    expect(names).toEqual(expected);
  });

  await step("a TrueFoundry outage during a sync keeps everyone's key instead of creating new ones", async () => {
    await user.see({ testId: "truefoundry-sync" }, { timeoutMs: WITHIN });
    const before = world.tenant.tokenCount();
    world.tenant.failModels(10);
    await sync();
    await user.see({ text: /^Synced/ }, { timeoutMs: WITHIN });
    world.tenant.failModels(0);
    const after = world.tenant.tokenCount();
    const models = await world.memberModels();
    const ok = after === before && JSON.stringify(models) === JSON.stringify(ALL);
    evidence.recordAssertionEvidence("Same number of tokens in TrueFoundry, and the member keeps every model", `tokens before=${before}, after=${after}; member=${JSON.stringify(models)}`, ok);
    expect(after).toBe(before);
    expect(models).toEqual(ALL);
  });

  await step("a person at TrueFoundry's token limit shows Too many tokens, with Reset tokens", async () => {
    world.tenant.fillTokens(email);
    await sync();
    await user.see({ text: /^Synced/ }, { timeoutMs: WITHIN });
    await user.see({ testId: "truefoundry-attention" }, { timeoutMs: WITHIN });
    await user.see({ text: "Too many tokens" });
    await user.see({ text: "Reset tokens" });
    evidence.recordAssertionEvidence("The member holds the maximum tokens, none of them OpenWork's", `tokens=${world.tenant.tokensOf(email)}`, world.tenant.tokensOf(email) === 3);
    await user.screenshot();
  });

  await step("Reset tokens explains that every token is revoked before doing it", async () => {
    await user.click({ text: "Reset tokens" });
    await user.see({ testId: "truefoundry-reset-tokens-dialog" }, { timeoutMs: WITHIN });
    await user.see({ text: /including ones they made for their laptop, scripts or other tools/ });
    const untouched = world.tenant.tokensOf(email);
    evidence.recordAssertionEvidence("Nothing is revoked until the admin confirms", `tokens=${untouched}`, untouched === 3);
    expect(untouched).toBe(3);
    await user.screenshot();
  });

  await step("confirming revokes their tokens and gives them one new OpenWork key", async () => {
    await user.click({ testId: "truefoundry-reset-tokens-confirm" });
    await user.see({ text: /TrueFoundry tokens and created a new key/ }, { timeoutMs: WITHIN });
    const models = await probe.eventually(() => world.memberModels(), { within: WITHIN, label: "the member is served again", until: (ids) => ids.length === ALL.length });
    const tokens = world.tenant.tokensOf(email);
    const ok = tokens === 1 && JSON.stringify(models) === JSON.stringify(ALL);
    evidence.recordAssertionEvidence("One token left (OpenWork's new key) and the member has every model", `tokens=${tokens}; member=${JSON.stringify(models)}`, ok);
    expect(tokens).toBe(1);
    expect(models).toEqual(ALL);
    await user.screenshot();
  });
});

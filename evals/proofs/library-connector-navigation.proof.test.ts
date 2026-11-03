import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryConnectorNavigation } from "../worlds/library-connector-navigation.ts";

const test = spec.world(libraryConnectorNavigation, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

// DESIGN P3/S3: the compact list only navigates; skill instructions stay behind
// native disclosures on details. P10: changed surfaces have captioned screenshots.
test("an owner opens assigned connectors in My Library, signs out only their account, and reads skills on plugin details", async ({ world, user, probe, step, evidence }) => {
  const manage = `/dashboard/mcp-connections/${world.connection.id}`;
  const libraryConnector = `/dashboard/library/connectors/${world.connection.id}`;
  const skillSummary = 'details[data-skill-preview] > summary';

  await step("the owner signs in to their own connector account", async () => {
    await user.see({ role: "heading", label: "Review notes" }, { timeoutMs: 90_000 });
    expect(await world.accounts()).toMatchObject({ owner: false, peer: true });
    await user.click({ role: "button", label: "Sign in" });
    const accounts = await probe.eventually(() => world.accounts(), {
      within: 45_000, label: "the owner's local OAuth sign-in completes", until: value => value.owner && value.peer,
    });
    const fingerprints = await world.tokenFingerprints();
    expect(fingerprints).toHaveLength(2);
    evidence.recordAssertionEvidence("Both people have distinct OAuth accounts", `owner=${accounts.owner}; teammate=${accounts.peer}; accounts=${fingerprints.length}`, accounts.owner && accounts.peer && fingerprints.length === 2);
  });

  await step("personal Library actions are available by default", async () => {
    await user.see({ role: "link", label: "Open in My Library" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Review notes" });
    await user.see({ role: "menuitem", label: "Sign out of your account" });
    await user.see({ role: "menuitem", label: "Sign everyone out" });
    const assigned = await world.assignedConnectionIds();
    evidence.recordAssertionEvidence("Personal actions are available for the owner's assigned connector", `connector in My Library=${assigned.includes(world.connection.id)}`, assigned.includes(world.connection.id));
    expect(assigned).toContain(world.connection.id);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("the connector header opens that same connector in My Library", async () => {
    await user.click({ role: "link", label: "Open in My Library" });
    await user.see({ testId: "library-connector" }, { timeoutMs: 30_000 });
    await user.see({ role: "heading", label: "Review notes" });
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The header opens the personal connector, not its management page", `destination=${route}`, route.endsWith(libraryConnector));
    expect(route).toBe(libraryConnector);
    await user.screenshot();
  });

  await step("an admin can go back from My Library to the connector's management page", async () => {
    await user.click({ role: "button", label: "More for Review notes" });
    await user.see({ role: "menuitem", label: "Manage" });
    await user.screenshot();
    await user.click({ role: "menuitem", label: "Manage" });
    await user.see({ testId: "admin-connector-page" }, { timeoutMs: 30_000 });
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("My Library links back to Manage for someone who can open it", `destination=${route}`, route === manage);
    expect(route).toBe(manage);
  });

  await step("the Manage Connectors menu also opens the personal connector", async () => {
    await user.navigate(world.url("/dashboard/mcp-connections"));
    // Compact rows reveal their menu on hover (or keyboard focus).
    await user.hover({ role: "link", label: /^Review notes/ });
    await user.see({ role: "button", label: "More for Review notes" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Review notes" });
    await user.see({ role: "menuitem", label: "Open in My Library" });
    await user.screenshot();
    await user.click({ role: "menuitem", label: "Open in My Library" });
    await user.see({ testId: "library-connector" }, { timeoutMs: 30_000 });
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The list menu reaches the same personal destination", `destination=${route}`, route.endsWith(libraryConnector));
    expect(route).toBe(libraryConnector);
  });

  await step("an unassigned connector stays manageable without offering personal Library actions", async () => {
    await user.navigate(world.url(`/dashboard/mcp-connections/${world.unassigned.id}`));
    await user.see({ role: "heading", label: "Unassigned notes" }, { timeoutMs: 60_000 });
    await user.notSee({ role: "link", label: "Open in My Library" });
    await user.click({ role: "button", label: "More for Unassigned notes" });
    await user.notSee({ role: "menuitem", label: "Sign out of your account" });
    const assigned = await world.assignedConnectionIds();
    evidence.recordAssertionEvidence("Managing a connector does not make it part of the owner's Library", `assigned connector present=${assigned.includes(world.connection.id)}; unassigned connector present=${assigned.includes(world.unassigned.id)}`, assigned.includes(world.connection.id) && !assigned.includes(world.unassigned.id));
    expect(assigned).not.toContain(world.unassigned.id);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("Sign out removes only the owner's account and keeps the teammate and sharing intact", async () => {
    await user.navigate(world.url(manage));
    await user.see({ role: "link", label: "Open in My Library" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Review notes" });
    await user.click({ role: "menuitem", label: "Sign out of your account" });
    await user.see({ role: "button", label: "Sign in" }, { timeoutMs: 30_000 });
    const accounts = await probe.eventually(() => world.accounts(), {
      within: 20_000, label: "only the owner's account is signed out", until: value => !value.owner && value.peer,
    });
    evidence.recordAssertionEvidence("Personal sign-out leaves the teammate connected and the connector shared", `owner=${accounts.owner}; teammate=${accounts.peer}; connector exists=${accounts.exists}; shared with everyone=${accounts.orgWide}`, !accounts.owner && accounts.peer && accounts.exists && accounts.orgWide);
    expect(accounts).toEqual({ owner: false, peer: true, exists: true, orgWide: true });
    // The tools the owner could use before signing out are not listed as still available.
    await user.see({ text: "They show up after you sign in." });
    const staleTools = (await probe.dom('[data-testid="connector-tool"]')).elements.length;
    evidence.recordAssertionEvidence("After signing out, no tools are listed as still available", `tools listed=${staleTools}`, staleTools === 0);
    expect(staleTools).toBe(0);
    await user.click({ role: "button", label: "More for Review notes" });
    await user.notSee({ role: "menuitem", label: "Sign out of your account" });
    await user.screenshot();
    await user.press("Escape");
  });

  await step("the plugin's management page reveals a human-titled skill and all its instructions inline", async () => {
    await user.navigate(world.url(`/dashboard/plugins/${world.pluginId}`));
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ text: world.pluginName });
    await user.see({ text: "Plan a review" });
    await user.notSee({ text: world.skillBody });
    const collapsed = await probe.dom("details[data-skill-preview][open]");
    expect(collapsed.elements).toHaveLength(0);
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillDescription });
    await user.see({ text: world.skillBody });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    evidence.recordAssertionEvidence("The skill expands without leaving the plugin and shows its full body", `initially open=${collapsed.elements.length}; full body displayed=${bodies.includes(world.skillBody)}; destination=${new URL(await probe.url()).pathname}`, collapsed.elements.length === 0 && bodies.includes(world.skillBody));
    expect(bodies).toContain(world.skillBody);
    expect(new URL(await probe.url()).pathname).toBe(`/dashboard/plugins/${world.pluginId}`);
    await user.screenshot();
  });

  await step("the Library plugin detail uses the same collapsed skill disclosure", async () => {
    await user.navigate(world.url(`/dashboard/library/plugins/${world.pluginId}`));
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ text: world.pluginName });
    await user.see({ text: "Plan a review" });
    await user.notSee({ text: world.skillBody });
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillDescription });
    await user.see({ text: world.skillBody });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    evidence.recordAssertionEvidence("The personal plugin reveals the exact same complete instructions", `full body displayed=${bodies.includes(world.skillBody)}; destination=${new URL(await probe.url()).pathname}`, bodies.includes(world.skillBody));
    expect(bodies).toContain(world.skillBody);
    await user.screenshot();
  });

  await step("the compact Library lists plugins without disclosures or fetching their details", async () => {
    // A full page navigation gives this list a fresh query cache: preceding detail
    // visits cannot accidentally satisfy the no-eager-detail-read witness.
    await user.navigate(world.url("/dashboard/library"));
    await user.see({ testId: "library-compact-sections" }, { timeoutMs: 60_000 });
    await user.see({ text: world.pluginName });
    await user.see({ text: world.singlePluginName });
    const previews = await probe.dom('[data-testid="library-screen"] details, [data-testid="library-screen"] [data-skill-steps]');
    expect(previews.elements).toHaveLength(0);
    expect((await probe.dom(skillSummary)).elements).toHaveLength(0);
    await user.notSee({ text: "Plan a review" });
    await user.notSee({ text: world.skillBody });
    const readsBefore = await world.pluginReads();
    const singleReadsBefore = await world.pluginReads(world.singlePluginId);
    evidence.recordAssertionEvidence("The compact list has no inline skill previews and fetches neither plugin's detail", `inline previews=${previews.elements.length}; toolkit detail reads=${readsBefore}; single-skill detail reads=${singleReadsBefore}`, previews.elements.length === 0 && readsBefore === 0 && singleReadsBefore === 0);
    expect(readsBefore).toBe(0);
    expect(singleReadsBefore).toBe(0);
    await user.screenshot();
  });

  await step("opening the plugin row fetches its detail once and reveals both skills there", async () => {
    // Nothing has fetched the detail while the list was on screen, including
    // while its screenshot settled. The row click is the loading boundary.
    expect(await world.pluginReads()).toBe(0);
    await user.click({ role: "link", label: /^Review toolkit/ });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 30_000 });
    await user.see({ text: "Plan a review" });
    await user.see({ text: "Capture decisions" });
    await user.notSee({ text: world.skillBody });
    expect((await probe.dom(skillSummary)).elements).toHaveLength(2);
    const readsAfter = await probe.eventually(() => world.pluginReads(), {
      within: 15_000, label: "opening the row fetches the plugin detail", until: count => count > 0,
    });
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillBody });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The row opens a dedicated detail page with two skills and their full instructions", `plugin detail reads=${readsAfter}; full body displayed=${bodies.includes(world.skillBody)}; destination=${route}`, readsAfter === 1 && bodies.includes(world.skillBody) && route === `/dashboard/library/plugins/${world.pluginId}`);
    expect(readsAfter).toBe(1);
    expect(bodies).toContain(world.skillBody);
    expect(route).toBe(`/dashboard/library/plugins/${world.pluginId}`);
    await user.screenshot();
  });

  await step("a failed plugin detail explains how to recover without showing stale skills", async () => {
    await world.failPluginReads();
    await user.navigate(world.url(`/dashboard/library/plugins/${world.pluginId}`));
    await user.see({ role: "heading", label: "It did not load" }, { timeoutMs: 30_000 });
    await user.see({ text: "Reload the page to try again." });
    await user.notSee({ text: world.skillBody });
    const previews = await probe.dom(skillSummary);
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The failed detail offers reload recovery and does not leave stale skill instructions visible", `skill disclosures=${previews.elements.length}; destination=${route}`, previews.elements.length === 0 && route === `/dashboard/library/plugins/${world.pluginId}`);
    expect(previews.elements).toHaveLength(0);
    expect(route).toBe(`/dashboard/library/plugins/${world.pluginId}`);
    await user.screenshot();
  });

  await step("reloading the detail restores its published instructions", async () => {
    await world.restorePluginReads();
    await user.reload();
    await user.see({ testId: "plugin-page" }, { timeoutMs: 30_000 });
    await user.see({ text: "Plan a review" });
    await user.notSee({ text: world.skillBody });
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillBody });
    await user.notSee({ role: "heading", label: "It did not load" });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    evidence.recordAssertionEvidence("Reload recovers the same plugin's complete instructions", `full body displayed=${bodies.includes(world.skillBody)}; destination=${new URL(await probe.url()).pathname}`, bodies.includes(world.skillBody) && new URL(await probe.url()).pathname === `/dashboard/library/plugins/${world.pluginId}`);
    expect(bodies).toContain(world.skillBody);
    expect(new URL(await probe.url()).pathname).toBe(`/dashboard/library/plugins/${world.pluginId}`);
    await user.screenshot();
  });

  await step("a one-skill row opens its detail, where long steps expand without duplicate skill rows", async () => {
    await user.navigate(world.url("/dashboard/library"));
    await user.see({ text: world.singlePluginName }, { timeoutMs: 30_000 });
    expect((await probe.dom('[data-testid="library-screen"] details')).elements).toHaveLength(0);
    expect(await world.pluginReads(world.singlePluginId)).toBe(0);
    await user.click({ role: "link", label: /^Meeting follow-up/ });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 30_000 });
    await user.see({ text: "Write a follow up" });
    expect((await probe.dom(skillSummary)).elements).toHaveLength(1);
    await user.notSee({ text: world.singleFirstLine });
    await user.click({ text: "Write a follow up" });
    await user.see({ text: world.singleFirstLine });
    await user.see({ role: "button", label: "Show all steps" });
    // Read the steps block itself: page-text matching only scans the top of a long page.
    const singleSteps = "details[data-skill-preview][open] pre";
    const previewText = (await probe.dom(singleSteps)).elements.map(element => element.text).join("\n");
    expect(previewText).toContain(world.singleFirstLine);
    expect(previewText).not.toContain(world.singleLastLine);
    const nested = (await probe.dom("details[data-skill-preview] details[data-skill-preview]")).elements.length;
    await user.screenshot();
    await user.click({ role: "button", label: "Show all steps" });
    await user.see({ role: "button", label: "Show less" });
    const fullText = (await probe.dom(singleSteps)).elements.map(element => element.text).join("\n");
    const lastShown = fullText.includes(world.singleLastLine);
    const route = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The single skill's detail keeps long instructions behind Show all steps without duplicating the skill", `nested skill rows=${nested}; last step in preview=${previewText.includes(world.singleLastLine)}; last step after Show all steps=${lastShown}; destination=${route}`, nested === 0 && !previewText.includes(world.singleLastLine) && lastShown && route === `/dashboard/library/plugins/${world.singlePluginId}`);
    expect(nested).toBe(0);
    expect(lastShown).toBe(true);
    expect(route).toBe(`/dashboard/library/plugins/${world.singlePluginId}`);
    await user.screenshot();
  });

});

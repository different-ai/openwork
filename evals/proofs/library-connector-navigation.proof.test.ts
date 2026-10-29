import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryConnectorNavigation } from "../worlds/library-connector-navigation.ts";

const test = spec.world(libraryConnectorNavigation, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

// DESIGN P3/S3: skill instructions stay behind native disclosures; P10: every
// changed surface and the unassigned boundary have a real, captioned screenshot.
test("an owner opens assigned connectors in My Library, signs out only their account, and reads a plugin's skills inline", async ({ world, user, probe, step, evidence }) => {
  const manage = `/dashboard/mcp-connections/${world.connection.id}`;
  const libraryConnector = `/dashboard/library/connectors/${world.connection.id}`;
  const skillSummary = 'details[data-skill-preview] > summary';

  await step("before: the owner signs in, but the connector page has no personal Library actions", async () => {
    await user.see({ role: "heading", label: "Review notes" }, { timeoutMs: 90_000 });
    expect(await world.accounts()).toMatchObject({ owner: false, peer: true });
    await user.click({ role: "button", label: "Sign in" });
    const accounts = await probe.eventually(() => world.accounts(), {
      within: 45_000, label: "the owner's local OAuth sign-in completes", until: value => value.owner && value.peer,
    });
    const fingerprints = await world.tokenFingerprints();
    expect(fingerprints).toHaveLength(2);
    await user.notSee({ role: "link", label: "Open in My Library" });
    await user.click({ role: "button", label: "More for Review notes" });
    await user.notSee({ role: "menuitem", label: "Sign out of your account" });
    const enabled = await world.navigationEnabled();
    evidence.recordAssertionEvidence("Both people are signed in before the rollout, with no personal actions on the admin page", `rollout=${enabled}; owner=${accounts.owner}; teammate=${accounts.peer}; distinct OAuth accounts=${fingerprints.length}`, !enabled && accounts.owner && accounts.peer && fingerprints.length === 2);
    expect(enabled).toBe(false);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: enabling the rollout adds Open in My Library and a sign-out scoped to the owner's account", async () => {
    await world.setNavigation(true);
    await user.reload();
    await user.see({ role: "link", label: "Open in My Library" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Review notes" });
    await user.see({ role: "menuitem", label: "Sign out of your account" });
    await user.see({ role: "menuitem", label: "Sign everyone out" });
    const assigned = await world.assignedConnectionIds();
    const enabled = await world.navigationEnabled();
    evidence.recordAssertionEvidence("Personal actions are available for the owner's assigned connector", `rollout=${enabled}; connector in My Library=${assigned.includes(world.connection.id)}`, enabled && assigned.includes(world.connection.id));
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

  await step("My Library loads a plugin's two skills only when the owner expands its skill count", async () => {
    // A full page navigation gives this list a fresh query cache: preceding detail
    // visits cannot accidentally satisfy the lazy-load witness.
    await user.navigate(world.url("/dashboard/library"));
    await user.see({ text: world.pluginName }, { timeoutMs: 60_000 });
    const readsBefore = await world.pluginReads();
    expect(readsBefore).toBe(0);
    const summaries = await probe.dom(`summary[aria-label="2 skills in ${world.pluginName}"]`);
    expect(summaries.elements).toHaveLength(1);
    expect(summaries.elements[0]?.text).toBe("2 skills");
    await user.notSee({ text: "Plan a review" });
    expect((await probe.dom(skillSummary)).elements).toHaveLength(0);
    expect(await world.pluginReads()).toBe(readsBefore);
    await user.screenshot();
    await user.click({ testId: `library-plugin-skills-${world.pluginId}` });
    await user.see({ text: "Plan a review" }, { timeoutMs: 30_000 });
    await user.see({ text: "Capture decisions" });
    const readsAfter = await probe.eventually(() => world.pluginReads(), {
      within: 15_000, label: "expanding Skills fetches the plugin", until: count => count > readsBefore,
    });
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillBody });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    evidence.recordAssertionEvidence("Expanding the skill count loads the plugin once and reveals both skills without navigation", `plugin detail reads added=${readsAfter - readsBefore}; full body displayed=${bodies.includes(world.skillBody)}; destination=${new URL(await probe.url()).pathname}`, readsAfter - readsBefore === 1 && bodies.includes(world.skillBody) && new URL(await probe.url()).pathname === "/dashboard/library");
    expect(readsAfter - readsBefore).toBe(1);
    expect(bodies).toContain(world.skillBody);
    expect(new URL(await probe.url()).pathname).toBe("/dashboard/library");
    await user.screenshot();
  });

  await step("a failed skill preview keeps the plugin in My Library and offers Try again", async () => {
    await world.failPluginReads();
    await user.navigate(world.url("/dashboard/library"));
    await user.see({ text: world.pluginName }, { timeoutMs: 60_000 });
    await user.click({ testId: `library-plugin-skills-${world.pluginId}` });
    await user.see({ text: "Skills could not load." }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Try again" });
    const alerts = (await probe.dom('[role="alert"]')).elements.map(element => element.text).join(" ");
    evidence.recordAssertionEvidence("The failed request has an inline recovery without removing the plugin", `inline message=${alerts}; destination=${new URL(await probe.url()).pathname}`, alerts.includes("Skills could not load.") && new URL(await probe.url()).pathname === "/dashboard/library");
    expect(alerts).toContain("Skills could not load.");
    await user.screenshot();
  });

  await step("Try again restores the skill preview in place", async () => {
    await world.restorePluginReads();
    await user.click({ role: "button", label: "Try again" });
    await user.see({ text: "Plan a review" }, { timeoutMs: 30_000 });
    await user.click({ text: "Plan a review" });
    await user.see({ text: world.skillBody });
    await user.notSee({ text: "Skills could not load." });
    const bodies = (await probe.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    evidence.recordAssertionEvidence("Retry shows the published instructions without leaving My Library", `full body displayed=${bodies.includes(world.skillBody)}`, bodies.includes(world.skillBody));
    expect(bodies).toContain(world.skillBody);
    await user.screenshot();
  });

  await step("a one-skill plugin opens straight to its steps, previewing long steps first", async () => {
    await user.see({ text: world.singlePluginName });
    const summary = await probe.dom(`[data-testid="library-plugin-skills-${world.singlePluginId}"]`);
    expect(summary.elements[0]?.text).toBe("Steps");
    await user.click({ testId: `library-plugin-skills-${world.singlePluginId}` });
    await user.see({ text: world.singleFirstLine }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Show all steps" });
    // Read the steps block itself: page-text matching only scans the top of a long page.
    const singleSteps = `details:has(> summary[data-testid="library-plugin-skills-${world.singlePluginId}"]) pre`;
    const previewText = (await probe.dom(singleSteps)).elements.map(element => element.text).join("\n");
    expect(previewText).toContain(world.singleFirstLine);
    expect(previewText).not.toContain(world.singleLastLine);
    // The skill is not listed again inside itself as a nested skill row.
    const nested = (await probe.dom(`details:has(> summary[data-testid="library-plugin-skills-${world.singlePluginId}"]) details[data-skill-preview]`)).elements.length;
    await user.screenshot();
    await user.click({ role: "button", label: "Show all steps" });
    await user.see({ role: "button", label: "Show less" });
    const fullText = (await probe.dom(singleSteps)).elements.map(element => element.text).join("\n");
    const lastShown = fullText.includes(world.singleLastLine);
    evidence.recordAssertionEvidence("A one-skill plugin shows its steps directly, with long steps behind Show all steps", `label=${summary.elements[0]?.text}; nested skill rows=${nested}; last step in preview=${previewText.includes(world.singleLastLine)}; last step after Show all steps=${lastShown}`, summary.elements[0]?.text === "Steps" && nested === 0 && !previewText.includes(world.singleLastLine) && lastShown);
    expect(nested).toBe(0);
    expect(lastShown).toBe(true);
    await user.screenshot();
  });

  await step("turning the rollout off restores the Library list without changing accounts or access", async () => {
    await world.setNavigation(false);
    await user.reload();
    await user.see({ text: world.pluginName }, { timeoutMs: 60_000 });
    expect((await probe.dom(`[data-testid="library-plugin-skills-${world.pluginId}"]`)).elements).toHaveLength(0);
    const accounts = await world.accounts();
    evidence.recordAssertionEvidence("The rollout can be reverted without signing out a teammate or removing access", `rollout=${await world.navigationEnabled()}; owner=${accounts.owner}; teammate=${accounts.peer}; connector exists=${accounts.exists}; shared=${accounts.orgWide}`, accounts.peer && accounts.exists && accounts.orgWide);
    expect(await world.navigationEnabled()).toBe(false);
    expect(accounts).toEqual({ owner: false, peer: true, exists: true, orgWide: true });
    await user.screenshot();
  });
});

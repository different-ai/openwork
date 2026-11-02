import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accessRolesWorld, accessRoleLookupFailure } from "../worlds/access-roles.ts";
import { record, rows } from "../worlds/org-invite.ts";

const test = spec.world(accessRolesWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });
const lookupTest = spec.world(accessRoleLookupFailure, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner edits organization access separately from team roles, without demoting an Admin when a team write fails", async ({ world, user, probe, step, evidence }) => {
  let customInOrganizationEditor = false;
  await step("the owner inspects the Admin's organization access choices", async () => {
    await user.see({ text: "Direct Admin" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Open actions for Direct Admin" });
    await user.click("Edit role");
    await user.click({ testId: "member-role-change" });
    await user.see({ role: "option", label: "Admin" });
    const choices = await probe.dom('[data-testid="member-role-choice"] [role="option"]');
    customInOrganizationEditor = choices.elements.some((entry) => entry.text.includes("Previous role"));
    evidence.recordAssertionEvidence("the owner can inspect the Admin's role choices", choices.elements.map((entry) => entry.text).join(", "), choices.elements.some((entry) => entry.text === "Admin"));
    await user.screenshot();
    await user.press("Escape");
    await user.click({ role: "button", label: "Cancel" });
  });
  await step("a failed team membership change leaves the direct Admin role unchanged", async () => {
    await world.traffic.faults.status(world.faultPath(`/v1/teams/${world.beta}`), 503, { method: "PATCH", body: { error: "unavailable", message: "Team update unavailable" } });
    await user.click({ role: "button", label: "Open actions for Direct Admin" });
    // Exercise the former combined action on the base, and the separate team
    // action on the head. Both reach the same real failed membership request.
    if (customInOrganizationEditor) {
      await user.click({ role: "menuitem", label: "Edit role" });
      await user.click({ testId: "member-role-change" });
      await user.click({ testId: `member-role-option-role:${world.previous}` });
      await user.click({ testId: "member-role-save" });
    } else {
      await user.click({ role: "menuitem", label: "Manage teams" });
      await user.click({ role: "button", label: "Beta team" });
      await user.click({ role: "button", label: "Save teams" });
    }
    const requests = await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "the team membership request failed", until: (entries) => entries.some((entry) => entry.path.endsWith(`/v1/teams/${world.beta}`) && entry.method === "PATCH" && entry.faulted && entry.status === 503) });
    evidence.recordAssertionEvidence("the membership failure really occurred", `failed Beta membership writes=${requests.filter((entry) => entry.path.endsWith(`/v1/teams/${world.beta}`) && entry.faulted).length}`, requests.some((entry) => entry.path.endsWith(`/v1/teams/${world.beta}`) && entry.faulted && entry.status === 503));
    await user.see({ text: "Team update unavailable" });
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    const member = rows(org.members).find((entry) => entry.id === world.targetId);
    const team = rows(org.teams).find((entry) => entry.id === world.beta);
    const safe = member?.role === "admin" && Array.isArray(team?.memberIds) && !team.memberIds.includes(world.targetId);
    evidence.recordAssertionEvidence("no intermediate demotion", `direct role=${String(member?.role)}; failed team membership is absent=${safe}`, safe);
    expect(safe).toBe(true);
    expect(customInOrganizationEditor).toBe(false);
    await user.screenshot();
  });
  await step("a member without access is refused another person's permissions", async () => {
    const denied = await probe.api(world.den.members.plain, `/v1/members/${world.targetId}/permissions`);
    evidence.recordAssertionEvidence("private permission sources remain protected", `HTTP ${denied.response.status}; custom role leaked=${denied.text.includes("Publisher role")}`, denied.response.status === 403 && !denied.text.includes("Publisher role"));
    expect(denied.response.status).toBe(403);
  });
});

lookupTest("an owner cannot mistake a failed role lookup for Member or change an unverified role", async ({ world, user, probe, step, evidence }) => {
  await step("before: a failed lookup leaves the team's custom role unverified", async () => {
    await user.see({ text: "Role not verified" }, { timeoutMs: 90_000 });
    await user.see({ text: "Couldn't verify this team's role. Changes are blocked until verification succeeds." });
    const blocked = await probe.dom('[data-testid="team-role-change"]:disabled');
    evidence.recordAssertionEvidence("unknown is not Member", `disabled custom-role controls=${blocked.elements.length}`, blocked.elements.length === 1);
    expect(blocked.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("after: retry verifies the team in place and restores the role action", async () => {
    await user.click({ role: "button", label: "Try again" });
    await user.see({ testId: "team-role-name" }, { text: "Previous role" });
    await probe.eventually(() => probe.dom('[data-testid="team-role-change"]:not(:disabled)'), { within: 30_000, label: "role prerequisites are verified", until: (result) => result.elements.length === 1 });
    await user.click({ testId: "team-role-change" });
    await user.see({ role: "option", label: /Publisher role/ });
    const choices = await probe.dom('[data-testid="team-role-choice"] [role="option"]');
    evidence.recordAssertionEvidence("retry restores verified choices", choices.elements.map((entry) => entry.text).join(", "), choices.elements.some((entry) => entry.text.includes("Publisher role")));
    await user.screenshot();
  });
  await step("choosing a custom role keeps organization Admin access as its own grant", async () => {
    await user.click({ testId: `team-role-option-${world.publisher}` });
    await user.see({ text: /Organization Admin access stays off\./ });
    await user.click({ testId: "team-role-save" });
    await user.see({ testId: "team-role-name" }, { text: "Publisher role" });
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    const admin = rows(org.teams).find((entry) => entry.id === world.beta)?.grantsOrganizationAdmin;
    evidence.recordAssertionEvidence("custom assignment does not change organization Admin access", `organization Admin access=${String(admin)}`, admin === false);
    expect(admin).toBe(false);
    await user.screenshot();
  });
  await step("a denied refresh masks the cached role, and remounting through a later network error cannot reveal it", async () => {
    await probe.eventually(() => probe.dom('[data-testid="team-role-change"]:not(:disabled)'), { within: 30_000, label: "the prior role change settled", until: (result) => result.elements.length === 1 });
    await world.traffic.faults.status(world.faultPath("/v1/permissions/sets"), 403, { method: "GET", body: { error: "forbidden", message: "Role read denied" } });
    await user.click({ testId: "team-role-change" });
    await user.click({ testId: `team-role-option-${world.previous}` });
    await user.click({ testId: "team-role-save" });
    await user.see({ testId: "team-role-name" }, { text: "Role not verified" });
    await user.notSee({ role: "link", label: "Open role" });
    await user.notSee({ text: "Publisher role" });
    await user.click({ role: "tab", label: "Members" });
    await world.traffic.faults.status(world.faultPath("/v1/permissions/sets"), 503, { method: "GET", body: { error: "unavailable", message: "Role check unavailable" } });
    await user.click({ role: "tab", label: "Role" });
    const requests = await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "the remounted role check failed after the denial", until: (entries) => entries.some((entry) => entry.method === "GET" && entry.path.endsWith("/v1/permissions/sets") && entry.status === 503 && entry.faulted && entries.some((denied) => denied.path === entry.path && denied.status === 403 && denied.at < entry.at)) });
    await user.see({ testId: "team-role-name" }, { text: "Role not verified" });
    await user.notSee({ role: "link", label: "Open role" });
    await user.notSee({ text: "Publisher role" });
    await user.notSee({ text: "Previous role" });
    const blocked = await probe.dom('[data-testid="team-role-change"]:disabled');
    evidence.recordAssertionEvidence("denied role metadata stays masked across remount and a later transient failure", `denied reads=${requests.filter((entry) => entry.status === 403 && entry.faulted).length}; disabled picker=${blocked.elements.length}`, requests.some((entry) => entry.status === 403 && entry.faulted) && blocked.elements.length === 1);
    expect(blocked.elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("only a new authorized read restores the current role and its action", async () => {
    await user.click({ role: "button", label: "Try again" });
    await user.see({ testId: "team-role-name" }, { text: "Previous role" });
    const ready = await probe.eventually(() => probe.dom('[data-testid="team-role-change"]:not(:disabled)'), { within: 30_000, label: "authorized role prerequisites restored", until: (result) => result.elements.length === 1 });
    evidence.recordAssertionEvidence("authorized recovery restores the verified role, not an older cached role", `verified role=Previous role; enabled picker=${ready.elements.length}`, ready.elements.length === 1);
    expect(ready.elements).toHaveLength(1);
    await user.screenshot();
  });
});

test("an owner sees replacement consequences and retries only the teams whose role assignment failed", async ({ world, user, probe, step, evidence }) => {
  let reviewedConsequences = "";
  await step("the owner reviews two selected teams before assigning their role", async () => {
    await user.navigate(world.url(`/dashboard/permissions/${world.publisher}`));
    await user.see({ testId: "role-teams" });
    await probe.eventually(() => probe.dom('[data-testid="role-teams"] button:not(:disabled)'), { within: 30_000, label: "team role inventory is verified", until: (result) => result.elements.length > 0 });
    await user.click({ role: "button", label: /^(Assign role|Add team)$/ });
    await user.click({ role: "option", label: /Alpha team/ });
    await user.click({ role: "option", label: /Beta team/ });
    const consequences = await probe.dom('[aria-label="Changes to review"]');
    reviewedConsequences = consequences.elements.map((entry) => entry.text).join("; ");
    const selected = await probe.dom('[data-testid="access-add-team-popover"] [role="option"][aria-selected="true"]');
    evidence.recordAssertionEvidence("two teams were selected before the write", selected.elements.map((entry) => entry.text).join("; "), selected.elements.length === 2);
    expect(selected.elements).toHaveLength(2);
    await user.screenshot();
  });
  await step("one failed team stays selected, with both teams' actual outcomes retained", async () => {
    await world.traffic.faults.status(world.faultPath(`/v1/teams/${world.beta}/permission-set`), 409, { method: "PUT", body: { error: "assignment_rejected", message: "Beta team rejected the assignment" } });
    const popup = await probe.dom('[data-testid="access-add-team-popover"] button');
    // Drive both versions' real submit action so the base fails after the fault,
    // not merely because its older entry point is named Add team.
    if (popup.elements.some((entry) => entry.text === "Assign role")) await user.click({ role: "button", label: "Assign role", nth: 1 });
    else await user.click({ role: "button", label: "Add 2 teams" });
    const faulted = await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "the second team's real write failed", until: (requests) => requests.some((entry) => entry.path.endsWith(`/${world.beta}/permission-set`) && entry.method === "PUT" && entry.faulted && entry.status === 409) });
    evidence.recordAssertionEvidence("the second team really hit a failed write", `faulted Beta writes=${faulted.filter((entry) => entry.path.endsWith(`/${world.beta}/permission-set`) && entry.faulted).length}`, faulted.some((entry) => entry.path.endsWith(`/${world.beta}/permission-set`) && entry.faulted && entry.status === 409));
    await user.see({ text: "1 team needs attention. Review the team results; only rejected assignments can be retried." });
    await user.press("Escape");
    const results = await probe.dom('[data-testid="role-assignment-result"]');
    evidence.recordAssertionEvidence("partial assignment names each outcome", results.elements.map((entry) => entry.text).join("; "), results.elements.some((entry) => entry.text.includes("Alpha team") && entry.text.includes("Role assigned")) && results.elements.some((entry) => entry.text.includes("Not assigned: Beta team rejected the assignment")));
    expect(results.elements).toHaveLength(2);
    await user.screenshot();
  });
  await step("after: retry sends only the failed team and both roles are confirmed", async () => {
    await user.click({ role: "button", label: "Retry failed teams" });
    await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "failed team retried", until: (requests) => requests.filter((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`)).length === 2 });
    const writes = (await world.traffic.requestLog()).filter((entry) => entry.method === "PUT" && entry.path.includes("/permission-set"));
    const alpha = writes.filter((entry) => entry.path.includes(world.alpha));
    const beta = writes.filter((entry) => entry.path.includes(world.beta));
    const results = await probe.eventually(() => probe.dom('[data-testid="role-assignment-result"]'), { within: 30_000, label: "both team outcomes confirmed", until: (result) => result.elements.length === 2 && result.elements.every((entry) => entry.text.includes("Role assigned")) });
    evidence.recordAssertionEvidence("retry does not replay successful writes", `Alpha writes=${alpha.length}; Beta writes=${beta.length}; confirmed teams=${results.elements.length}`, alpha.length === 1 && beta.length === 2);
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(2);
    expect(reviewedConsequences).toContain("Replaces Previous role");
    expect(reviewedConsequences).toContain("keeps organization Admin access");
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    expect(rows(org.teams).find((entry) => entry.id === world.alpha)?.grantsOrganizationAdmin).toBe(true);
    await user.screenshot();
  });
});

test("an owner keeps a timed-out assignment unconfirmed and checks current roles without replaying the write", async ({ world, user, probe, step, evidence }) => {
  await step("the owner submits one team and the real request times out before its result is known", async () => {
    await user.navigate(world.url(`/dashboard/permissions/${world.publisher}`));
    await user.see({ testId: "role-teams" });
    await probe.eventually(() => probe.dom('[data-testid="role-teams"] button:not(:disabled)'), { within: 30_000, label: "role prerequisites verified", until: (result) => result.elements.length > 0 });
    await user.click({ role: "button", label: /^(Assign role|Add team)$/ });
    await user.click({ role: "option", label: /Beta team/ });
    await world.traffic.faults.latency(world.faultPath(`/v1/teams/${world.beta}/permission-set`), 20_000, { times: 1, method: "PUT" });
    const popup = await probe.dom('[data-testid="access-add-team-popover"] button');
    if (popup.elements.some((entry) => entry.text === "Assign role")) await user.click({ role: "button", label: "Assign role", nth: 1 });
    else await user.click({ role: "button", label: "Add Beta team" });
    const timedOut = await probe.eventually(() => world.traffic.requestLog(), { within: 45_000, label: "the real timed-out write was observed", until: (requests) => requests.some((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`) && entry.faulted && entry.status === 499) });
    evidence.recordAssertionEvidence("the submitted write really lost its response", `timed-out writes=${timedOut.filter((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`) && entry.status === 499).length}`, timedOut.some((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`) && entry.status === 499));
    await user.see({ text: "1 team needs attention. Review the team results; only rejected assignments can be retried." });
    await user.screenshot();
  });
  await step("submitting the retained selection again does not replay an unconfirmed request", async () => {
    await user.click({ role: "button", label: "Assign role", nth: 1 });
    await user.see({ text: "These teams need a current-role check or review. No assignment was replayed." });
    await user.press("Escape");
    await user.see({ testId: "role-assignment-result" }, { text: /Unconfirmed:/ });
    await user.notSee({ role: "button", label: "Retry failed teams" });
    const writes = (await world.traffic.requestLog()).filter((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`));
    evidence.recordAssertionEvidence("unknown is not a retryable failure", `submitted write count=${writes.length}; automatic retry offered=false`, writes.length === 1);
    expect(writes).toHaveLength(1);
    await user.screenshot();
  });
  await step("checking current roles is read-only, and an old role never turns the unknown request into a failed-only retry", async () => {
    const before = (await world.traffic.requestLog()).filter((entry) => entry.method === "GET" && entry.path.endsWith("/v1/permissions/sets")).length;
    await user.click({ role: "button", label: "Check current roles" });
    await probe.eventually(() => world.traffic.requestLog(), { within: 30_000, label: "current role read completed", until: (requests) => requests.filter((entry) => entry.method === "GET" && entry.path.endsWith("/v1/permissions/sets")).length > before });
    await user.see({ testId: "role-assignment-result" }, { text: /Current custom role: Previous role/ });
    await user.notSee({ role: "button", label: "Retry failed teams" });
    const writes = (await world.traffic.requestLog()).filter((entry) => entry.method === "PUT" && entry.path.endsWith(`/${world.beta}/permission-set`));
    const unconfirmed = await probe.dom('[data-testid="role-assignment-result"][data-status="unconfirmed"]');
    evidence.recordAssertionEvidence("a current-role check does not replay the write or invent a rejected outcome", `write count=${writes.length}; unconfirmed rows=${unconfirmed.elements.length}`, writes.length === 1 && unconfirmed.elements.length === 1);
    expect(writes).toHaveLength(1);
    expect(unconfirmed.elements).toHaveLength(1);
    await user.screenshot();
  });
});

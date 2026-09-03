import { expect } from "vitest";
import { denFetch, evalIn, freshSession, signInInBrowser, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { screenshot, validate } from "@openwork/test-evidence";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `plugin access panel skipped — needs: ${missingRequirements.join(", ")}`
  : "plugin creators can inspect person and team grants while team details deny non-members";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function organizationMemberIdByEmail(session: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: {
      ...auth(session),
      "x-openwork-org-id": orgId,
    },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const memberId = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !memberId.startsWith("om_")) {
    throw new Error(`Resolving ${email} in the organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberId;
}

async function promoteToAdmin(admin: DenSession, orgId: string, memberId: string): Promise<void> {
  const privilegedAdmin = await freshSession(admin);
  const result = await denFetch(privilegedAdmin, `/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: {
      ...auth(privilegedAdmin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ role: "admin" }),
  });
  if (!result.response.ok) {
    throw new Error(`Promoting the plugin creator failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

function accessItems(body: unknown): Record<string, unknown>[] {
  return isRecord(body) && Array.isArray(body.items) ? body.items.filter(isRecord) : [];
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  await using den = await server({
    place,
    org: {
      name: `Plugin Access Panel ${stamp}`,
      admin: { name: "Access Panel Owner" },
      members: {
        creator: { name: "Casey Creator" },
        member: { name: "Nova Member" },
      },
    },
  });
  const creator = den.members.creator;
  const member = den.members.member;
  if (!creator || !member) throw new Error("server() did not provision the creator and member sessions");

  const orgId = await organizationId(den.admin);
  const creatorMemberId = await organizationMemberIdByEmail(den.admin, orgId, creator.email);
  const memberId = await organizationMemberIdByEmail(den.admin, orgId, member.email);
  await promoteToAdmin(den.admin, orgId, creatorMemberId);

  const pluginName = `Spec Access Panel Plugin ${stamp}`;
  const rawSourceText = `---\nname: spec-access-panel-${stamp}\ndescription: Proves the plugin access panel.\n---\n\nReturn the plugin access panel proof phrase.`;
  const createdPlugin = await denFetch(creator, "/v1/plugins", {
    method: "POST",
    headers: {
      ...auth(creator),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: pluginName,
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const plugin = isRecord(createdPlugin.body) && isRecord(createdPlugin.body.item) ? createdPlugin.body.item : null;
  const pluginId = plugin && typeof plugin.id === "string" ? plugin.id : "";
  if (createdPlugin.response.status !== 201 || !pluginId) {
    throw new Error(`Creating the plugin failed: HTTP ${createdPlugin.response.status} ${createdPlugin.text.slice(0, 500)}`);
  }

  const grantedMember = await denFetch(creator, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      ...auth(creator),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ orgMembershipId: memberId, role: "viewer" }),
  });
  if (grantedMember.response.status !== 201) {
    throw new Error(`Granting member access failed: HTTP ${grantedMember.response.status} ${grantedMember.text.slice(0, 500)}`);
  }

  const teamName = `Spec Plugin Access Team ${stamp}`;
  const createdTeam = await denFetch(den.admin, "/v1/teams", {
    method: "POST",
    headers: {
      ...auth(den.admin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ name: teamName }),
  });
  const team = isRecord(createdTeam.body) && isRecord(createdTeam.body.team) ? createdTeam.body.team : null;
  const teamId = team && typeof team.id === "string" ? team.id : "";
  if (createdTeam.response.status !== 201 || !teamId) {
    throw new Error(`Creating the plugin access team failed: HTTP ${createdTeam.response.status} ${createdTeam.text.slice(0, 500)}`);
  }
  const updatedTeam = await denFetch(den.admin, `/v1/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    headers: {
      ...auth(den.admin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ memberIds: [creatorMemberId] }),
  });
  if (!updatedTeam.response.ok) {
    throw new Error(`Adding the creator to the team failed: HTTP ${updatedTeam.response.status} ${updatedTeam.text.slice(0, 500)}`);
  }
  const grantedTeam = await denFetch(creator, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      ...auth(creator),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (grantedTeam.response.status !== 201) {
    throw new Error(`Granting team access failed: HTTP ${grantedTeam.response.status} ${grantedTeam.text.slice(0, 500)}`);
  }

  const listedAccess = await denFetch(creator, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    headers: {
      ...auth(creator),
      "x-openwork-org-id": orgId,
    },
  });
  expect(listedAccess.response.status).toBe(200);
  const activeGrants = accessItems(listedAccess.body).filter((grant) => grant.removedAt === null);
  expect(activeGrants).toHaveLength(3);
  expect(activeGrants.some((grant) => grant.orgMembershipId === creatorMemberId && grant.role === "manager")).toBe(true);
  expect(activeGrants.some((grant) => grant.orgMembershipId === memberId && grant.role === "viewer")).toBe(true);
  expect(activeGrants.some((grant) => grant.teamId === teamId && grant.role === "viewer")).toBe(true);

  await using browser = await chrome({
    name: "plugin-access-panel",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before creator auth token handoff",
  });
  await signInInBrowser(browser, den.ref.webUrl, creator);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/plugins/${encodeURIComponent(pluginId)}`);
  await waitFor(browser, `document.body.innerText.toUpperCase().includes("WHO CAN ACCESS THIS")
    && document.body.innerText.includes("Nova Member")
    && document.body.innerText.includes(${JSON.stringify(teamName)})
    && document.body.innerText.toLowerCase().includes("viewer")
    && document.body.innerText.includes("Revoke")`, {
    timeoutMs: 60_000,
    label: "creator plugin access panel with person and team grants",
  });
  const orgWideTogglePresent = await evalIn(browser, `document.body.innerText.includes("Everyone in the organization")`);
  expect(orgWideTogglePresent).toBe(true);
  evidence.recordAssertionEvidence(
    "The plugin creator sees the person and team viewer grants",
    `The access panel listed Nova Member and ${teamName}, viewer roles, revoke controls, and the organization-wide control.`,
    orgWideTogglePresent === true,
  );
  const pluginShot = await screenshot(browser);
  const pluginSeen = await validate(pluginShot, [
    "An access section lists a person and a team with viewer role pills",
    "A revoke button is visible next to a shared row",
  ]);
  expect(pluginSeen.ok, pluginSeen.why).toBe(true);

  const teamUrl = `${den.ref.webUrl}/dashboard/members/teams/${encodeURIComponent(teamId)}`;
  await navigate(browser.client, teamUrl);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(teamName)})
    && document.body.innerText.includes(${JSON.stringify(pluginName)})
    && document.body.innerText.includes("direct team grant")
    && document.body.innerText.toLowerCase().includes("viewer")`, {
    timeoutMs: 60_000,
    label: "team member sees the direct team grant",
  });
  evidence.recordAssertionEvidence(
    "A team member sees the direct team plugin grant on the team detail screen",
    `${teamName} listed ${pluginName} with direct team grant and viewer role for creator-member Casey.`,
    true,
  );
  const teamShot = await screenshot(browser);
  const teamSeen = await validate(teamShot, [
    "A team access table lists a plugin with a direct team grant badge",
    "A role pill reading viewer is visible",
  ]);
  expect(teamSeen.ok, teamSeen.why).toBe(true);

  await browser.client.send("Network.clearBrowserCookies");
  await evalIn(browser, `localStorage.removeItem("openwork:web:auth-token")`);
  await signInInBrowser(browser, den.ref.webUrl, member);
  await evalIn(browser, `localStorage.removeItem("openwork:eval:admin-denial-seen")`);
  await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const capture = () => {
        if (document.body?.innerText.includes("This setting is managed by workspace admins")) {
          localStorage.setItem("openwork:eval:admin-denial-seen", "true");
        }
      };
      const start = () => {
        capture();
        new MutationObserver(capture).observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    })();`,
  });
  await navigate(browser.client, teamUrl);
  await waitFor(browser, `localStorage.getItem("openwork:eval:admin-denial-seen") === "true"
    && location.pathname === "/dashboard"`, {
    timeoutMs: 30_000,
    label: "non-team member sees the denial before returning to the dashboard",
  });
  const deniedText = await evalIn(browser, `document.body.innerText`);
  expect(String(deniedText)).not.toContain(pluginName);
  evidence.recordAssertionEvidence(
    "A non-team member is denied the team detail screen",
    "Nova saw the workspace-admin denial and no plugin grant details.",
    !String(deniedText).includes(pluginName),
  );
  await screenshot(browser);
});

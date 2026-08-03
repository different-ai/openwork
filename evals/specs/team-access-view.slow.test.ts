import { expect, onTestFinished, test } from "vitest";
import { denFetch, ensureMemberSession, evalIn, fill, signIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim().replace(/\/+$/, "") ?? "";
const title = !apiUrl
  ? "team access view skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den API"
  : !webUrl
    ? "team access view skipped: set OPENWORK_EVAL_DEN_WEB_URL to a running Den Web"
    : "team members can inspect effective plugin access while non-members are denied";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = orgs.find((entry) => entry.slug === "acme-robotics-demo")
    ?? orgs.find((entry) => entry.name === "Acme Robotics")
    ?? orgs[0];
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ organizationId: orgId }),
  });
  if (!result.response.ok) {
    throw new Error(`Selecting Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function organizationMemberIdByEmail(session: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const memberId = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !memberId.startsWith("om_")) {
    throw new Error(`Resolving ${email} in the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberId;
}

function accessItems(body: unknown): Record<string, unknown>[] {
  return isRecord(body) && Array.isArray(body.items) ? body.items.filter(isRecord) : [];
}

function pluginIdForAccessItem(item: Record<string, unknown>): string {
  return isRecord(item.plugin) && typeof item.plugin.id === "string" ? item.plugin.id : "";
}

test.skipIf(!apiUrl || !webUrl)(title, async () => {
  const den = { apiUrl, webUrl };
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
  const admin = await signIn(den, {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    password,
  });
  const orgId = await organizationId(admin);
  await selectOrganization(admin, orgId);

  const stamp = Date.now();
  const teamName = `Spec Access Team ${stamp}`;
  const createdTeam = await denFetch(admin, "/v1/teams", {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ name: teamName }),
  });
  const team = isRecord(createdTeam.body) && isRecord(createdTeam.body.team) ? createdTeam.body.team : null;
  const teamId = team && typeof team.id === "string" ? team.id : "";
  if (createdTeam.response.status !== 201 || !teamId) {
    throw new Error(`Creating the spec access team failed: HTTP ${createdTeam.response.status} ${createdTeam.text.slice(0, 500)}`);
  }

  let caseySession: DenSession | undefined;
  let pluginId = "";
  onTestFinished(async () => {
    const creator = caseySession;
    const createdPluginId = pluginId;
    if (creator && createdPluginId) {
      await denFetch(creator, `/v1/plugins/${encodeURIComponent(createdPluginId)}/archive`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creator.token}`,
          "x-openwork-org-id": orgId,
        },
      }).catch(() => undefined);
    }
    await denFetch(admin, `/v1/teams/${encodeURIComponent(teamId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${admin.token}`,
        "x-openwork-org-id": orgId,
      },
    }).catch(() => undefined);
  });

  const caseyEmail = process.env.OPENWORK_EVAL_CREATOR_EMAIL?.trim() || "casey.spec@acme.test";
  caseySession = await ensureMemberSession(den, admin, {
    email: caseyEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || password,
    name: "Casey Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  const casey = caseySession;
  await selectOrganization(casey, orgId);
  const caseyMemberId = await organizationMemberIdByEmail(admin, orgId, caseyEmail);
  const updatedTeam = await denFetch(admin, `/v1/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ memberIds: [caseyMemberId] }),
  });
  if (!updatedTeam.response.ok) {
    throw new Error(`Adding Casey to the spec access team failed: HTTP ${updatedTeam.response.status} ${updatedTeam.text.slice(0, 500)}`);
  }

  const pluginName = `Spec Team Access Plugin ${stamp}`;
  const skillName = `spec-team-access-${stamp}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves effective team plugin access.\n---\n\nReturn the team access proof phrase.`;
  const createdPlugin = await denFetch(casey, "/v1/plugins", {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: pluginName,
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const plugin = isRecord(createdPlugin.body) && isRecord(createdPlugin.body.item) ? createdPlugin.body.item : null;
  pluginId = plugin && typeof plugin.id === "string" ? plugin.id : "";
  if (createdPlugin.response.status !== 201 || !pluginId) {
    throw new Error(`Creating the team access plugin failed: HTTP ${createdPlugin.response.status} ${createdPlugin.text.slice(0, 500)}`);
  }

  const granted = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (granted.response.status !== 201) {
    throw new Error(`Granting team access failed: HTTP ${granted.response.status} ${granted.text.slice(0, 500)}`);
  }

  const adminAccess = await denFetch(admin, `/v1/teams/${encodeURIComponent(teamId)}/plugin-access`, {
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(adminAccess.response.status).toBe(200);
  const adminItems = accessItems(adminAccess.body);
  const directAccess = adminItems.find((item) => item.edge === "direct_team" && pluginIdForAccessItem(item) === pluginId);
  expect(directAccess).toBeDefined();
  if (!directAccess) throw new Error(`Admin response omitted the direct team access row: ${adminAccess.text.slice(0, 500)}`);
  expect(directAccess.role).toBe("viewer");
  expect(typeof directAccess.grantId === "string" && directAccess.grantId.length > 0).toBe(true);
  const grantedBy = isRecord(directAccess.grantedBy) ? directAccess.grantedBy : null;
  expect(grantedBy && typeof grantedBy.name === "string" && grantedBy.name.includes("Casey")).toBe(true);
  expect(adminItems.some((item) => item.edge === "org_wide")).toBe(true);

  const caseyAccess = await denFetch(casey, `/v1/teams/${encodeURIComponent(teamId)}/plugin-access`, {
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(caseyAccess.response.status).toBe(200);
  expect(
    accessItems(caseyAccess.body).some((item) => item.edge === "direct_team" && pluginIdForAccessItem(item) === pluginId && item.role === "viewer"),
  ).toBe(true);

  const nova = await ensureMemberSession(den, admin, {
    email: process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "nova.spec@acme.test",
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || password,
    name: "Nova Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(nova, orgId);
  const novaAccess = await denFetch(nova, `/v1/teams/${encodeURIComponent(teamId)}/plugin-access`, {
    headers: {
      authorization: `Bearer ${nova.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(novaAccess.response.status).toBe(403);

  await using browser = await chrome({ name: "p3-team-access", startUrl: webUrl, headless: true });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(admin.token)};
  })()`);
  expect(tokenStored).toBe(true);

  const teamUrl = `${webUrl}/dashboard/members/teams/${encodeURIComponent(teamId)}`;
  await navigate(browser.client, teamUrl);
  const teamAccessReady = `document.body.innerText.includes(${JSON.stringify(teamName)})
    && document.body.innerText.includes("direct team grant")`;
  let handoffError: unknown;
  try {
    await waitFor(browser, teamAccessReady, { timeoutMs: 60_000, label: "team name and direct team grant" });
  } catch (error) {
    handoffError = error;
  }

  if (handoffError) {
    const hasAuthInput = await evalIn(
      browser,
      `Boolean(document.querySelector('input[type="email"], input[name="email"], input[type="password"]'))`,
    );
    if (hasAuthInput !== true) throw handoffError;

    const hasEmailInput = await evalIn(browser, `Boolean(document.querySelector('input[type="email"], input[name="email"]'))`);
    const hasPasswordInput = await evalIn(browser, `Boolean(document.querySelector('input[type="password"]'))`);
    if (hasEmailInput === true) {
      await fill(browser, 'input[type="email"], input[name="email"]', admin.email);
    }
    if (hasEmailInput === true && hasPasswordInput !== true) {
      const nextClicked = await evalIn(browser, `(() => {
        const button = [...document.querySelectorAll("button")]
          .find((entry) => (entry.textContent ?? "").trim() === "Next");
        button?.click();
        return Boolean(button);
      })()`);
      expect(nextClicked).toBe(true);
      await waitFor(browser, `Boolean(document.querySelector('input[type="password"]'))`, {
        timeoutMs: 30_000,
        label: "Den Web password step",
      });
    }
    await fill(browser, 'input[type="password"]', password);
    const signInClicked = await evalIn(browser, `(() => {
      const button = [...document.querySelectorAll("button")]
        .reverse()
        .find((entry) => (entry.textContent ?? "").trim() === "Sign in");
      button?.click();
      return Boolean(button);
    })()`);
    expect(signInClicked).toBe(true);
    await waitFor(browser, `location.pathname.startsWith("/dashboard") && !document.querySelector('input[type="password"]')`, {
      timeoutMs: 60_000,
      label: "Den Web dashboard after form sign-in",
    });
    await navigate(browser.client, teamUrl);
    await waitFor(browser, teamAccessReady, { timeoutMs: 60_000, label: "team name and direct team grant after form sign-in" });
  }

  const shot = await screenshot(browser);
  const seen = await validate(shot, [
    "A team access table lists a plugin with a direct team grant badge",
    "A role pill reading viewer is visible",
  ]);
  await using roll = photoRoll("p3-team-access");
  await roll.add(shot, seen);
  expect(seen.ok, seen.why).toBe(true);
});

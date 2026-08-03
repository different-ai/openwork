import { expect, onTestFinished, test } from "vitest";
import { denFetch, ensureMemberSession, evalIn, fill, signIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim().replace(/\/+$/, "") ?? "";
const title = !apiUrl
  ? "plugin access panel skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den API"
  : !webUrl
    ? "plugin access panel skipped: set OPENWORK_EVAL_DEN_WEB_URL to a running Den Web"
    : "plugin creators can inspect person and team access grants in Den Web";

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

test.skipIf(!apiUrl || !webUrl)(title, async () => {
  const den = { apiUrl, webUrl };
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
  const admin = await signIn(den, {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    password,
  });
  const orgId = await organizationId(admin);
  await selectOrganization(admin, orgId);

  let caseySession: DenSession | undefined;
  let pluginId = "";
  let teamId = "";
  onTestFinished(async () => {
    const creator = caseySession;
    const createdPluginId = pluginId;
    const createdTeamId = teamId;
    if (creator && createdPluginId) {
      await denFetch(creator, `/v1/plugins/${encodeURIComponent(createdPluginId)}/archive`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creator.token}`,
          "x-openwork-org-id": orgId,
        },
      }).catch(() => undefined);
    }
    if (createdTeamId) {
      await denFetch(admin, `/v1/teams/${encodeURIComponent(createdTeamId)}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${admin.token}`,
          "x-openwork-org-id": orgId,
        },
      }).catch(() => undefined);
    }
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

  const novaEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "nova.spec@acme.test";
  const nova = await ensureMemberSession(den, admin, {
    email: novaEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || password,
    name: "Nova Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(nova, orgId);

  const stamp = Date.now();
  const pluginName = `spec-access-panel-${stamp}`;
  const rawSourceText = `---\nname: ${pluginName}\ndescription: Proves the plugin access panel.\n---\n\nReturn the plugin access panel proof phrase.`;
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
    throw new Error(`Creating the plugin access panel fixture failed: HTTP ${createdPlugin.response.status} ${createdPlugin.text.slice(0, 500)}`);
  }

  const caseyMemberId = await organizationMemberIdByEmail(casey, orgId, caseyEmail);
  const novaMemberId = await organizationMemberIdByEmail(casey, orgId, novaEmail);
  const grantedNova = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ orgMembershipId: novaMemberId, role: "viewer" }),
  });
  if (grantedNova.response.status !== 201) {
    throw new Error(`Granting Nova plugin access failed: HTTP ${grantedNova.response.status} ${grantedNova.text.slice(0, 500)}`);
  }

  const teamName = `Spec Plugin Access Team ${stamp}`;
  const createdTeam = await denFetch(admin, "/v1/teams", {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ name: teamName }),
  });
  const team = isRecord(createdTeam.body) && isRecord(createdTeam.body.team) ? createdTeam.body.team : null;
  teamId = team && typeof team.id === "string" ? team.id : "";
  if (createdTeam.response.status !== 201 || !teamId) {
    throw new Error(`Creating the plugin access team failed: HTTP ${createdTeam.response.status} ${createdTeam.text.slice(0, 500)}`);
  }

  const grantedTeam = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (grantedTeam.response.status !== 201) {
    throw new Error(`Granting team plugin access failed: HTTP ${grantedTeam.response.status} ${grantedTeam.text.slice(0, 500)}`);
  }

  const listedAccess = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(listedAccess.response.status).toBe(200);
  const activeGrants = accessItems(listedAccess.body).filter((grant) => grant.removedAt === null);
  expect(activeGrants).toHaveLength(3);
  expect(activeGrants.some((grant) => grant.orgMembershipId === caseyMemberId && grant.role === "manager")).toBe(true);
  expect(activeGrants.some((grant) => grant.orgMembershipId === novaMemberId && grant.role === "viewer")).toBe(true);
  expect(activeGrants.some((grant) => grant.teamId === teamId && grant.role === "viewer")).toBe(true);

  // Members are redirected from this admin route after seeing "Your workspace is ready" and
  // "This setting is managed by workspace admins. Taking you back to your dashboard."
  await using browser = await chrome({ name: "p3-plugin-access", startUrl: webUrl, headless: true });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(admin.token)};
  })()`);
  expect(tokenStored).toBe(true);

  const pluginUrl = `${webUrl}/dashboard/plugins/${encodeURIComponent(pluginId)}`;
  await navigate(browser.client, pluginUrl);
  const accessPanelReady = `document.body.innerText.toUpperCase().includes("WHO CAN ACCESS THIS")
    && document.body.innerText.includes("Nova Spec")
    && document.body.innerText.toLowerCase().includes("viewer")
    && document.body.innerText.includes(${JSON.stringify(teamName)})
    && document.body.innerText.includes("Revoke")`;
  let handoffError: unknown;
  try {
    await waitFor(browser, accessPanelReady, { timeoutMs: 60_000, label: "plugin access heading, Nova, and viewer role" });
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
    await navigate(browser.client, pluginUrl);
    await waitFor(browser, accessPanelReady, { timeoutMs: 60_000, label: "plugin access panel after form sign-in" });
  }

  const orgWideTogglePresent = await evalIn(
    browser,
    `document.body.innerText.includes("Everyone in the organization")`,
  );
  expect(orgWideTogglePresent).toBe(true);

  const shot = await screenshot(browser);
  const seen = await validate(shot, [
    "An access section lists a person and a team with viewer role pills",
    "A revoke button is visible next to a shared row",
  ]);
  await using roll = photoRoll("p3-plugin-access");
  await roll.add(shot, seen);
  expect(seen.ok, seen.why).toBe(true);
});

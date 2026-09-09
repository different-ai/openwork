import { expect } from "vitest";
import { denFetch, evalIn, fill, waitFor, type DenSession } from "@openwork/behaviors";
import { browserScript, navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { eventually, needs, server, test } from "@openwork/testkit";
import { parseTeamAdminContext } from "./helpers/team-admin-context.ts";

test("owners toggle team Admin in Den Web while inherited admins see a disabled checkbox and provenance", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({ place, web: true, org: { name: "Team Admin UI", members: { teammate: { name: "Inherited Teammate" } } } });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Missing teammate");
  const org = async (session = den.admin) => {
    const result = await denFetch(session, "/v1/org", { headers: { authorization: `Bearer ${session.token}` } });
    expect(result.response.status, result.text).toBe(200);
    return parseTeamAdminContext(result.body);
  };
  const initial = await org();
  const member = initial.members.find((entry) => entry.user.email === teammate.email);
  if (!member) throw new Error("Missing member");
  const teamName = "UI Operations";
  const created = await denFetch(den.admin, "/v1/teams", { method: "POST", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ name: teamName, memberIds: [member.id] }) });
  expect(created.response.status, created.text).toBe(201);
  const team = (await org()).teams.find((entry) => entry.name === teamName);
  if (!team) throw new Error("Missing team");
  await using browser = await chrome({ name: "team-admin-ui", host: place.host(), startUrl: den.ref.webUrl, headless: true });
  await navigate(browser.client, den.ref.webUrl);
  await waitFor(browser, browserScript((url) => location.href.startsWith(url) && document.readyState === "complete", [den.ref.webUrl]), { timeoutMs: 60_000, label: "Den Web origin loaded" });
  const teamPath = `/dashboard/members/teams/${team.id}`;
  const clickButton = (label: string) => evalIn(browser, browserScript((label) => {
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label));
    if (!button) throw new Error(`Missing button ${label}`);
    button.click();
  }, [label]));
  const clickCheckbox = () => evalIn(browser, () => {
    const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error("Missing checkbox");
    input.click();
  });
  const checkboxState = () => evalIn(browser, () => {
    const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error("Missing checkbox");
    return { disabled: input.disabled, checked: input.checked };
  });
  const showAs = async (session: DenSession) => {
    await evalIn(browser, async () => {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
      localStorage.removeItem("openwork:web:auth-token");
    }, { awaitPromise: true, timeoutMs: 30_000 });
    await navigate(browser.client, den.ref.webUrl);
    await waitFor(browser, () => Boolean(document.querySelector('input[type="email"]')), { timeoutMs: 30_000, label: "email sign-in step" });
    await fill(browser, 'input[type="email"]', session.email);
    await clickButton("Next");
    await waitFor(browser, () => Boolean(document.querySelector('input[type="password"]')), { timeoutMs: 30_000, label: "password sign-in step" });
    await fill(browser, 'input[type="password"]', session.password);
    await clickButton("Sign in");
    await waitFor(browser, () => location.pathname.startsWith("/dashboard") && Boolean(document.querySelector('a[href="/dashboard/members"]')), { timeoutMs: 30_000, label: "signed-in dashboard navigation" });
    await evalIn(browser, () => document.querySelector<HTMLAnchorElement>('a[href="/dashboard/members"]')?.click());
    await waitFor(browser, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Teams")), { timeoutMs: 30_000, label: "Members page" });
    await clickButton("Teams");
    await waitFor(browser, browserScript((path) => Boolean(document.querySelector(`a[href="${path}"]`)), [teamPath]), { timeoutMs: 30_000, label: "Teams list" });
    await evalIn(browser, browserScript((path) => document.querySelector<HTMLAnchorElement>(`a[href="${path}"]`)?.click(), [teamPath]));
    await waitFor(browser, browserScript((path) => location.pathname === path && document.body.innerText.includes("Grant organisation Admin to all members of UI Operations") && Boolean(document.querySelector('[role="tablist"]')) && Boolean(document.querySelector('input[type="checkbox"]')), [teamPath]), { timeoutMs: 60_000, label: "team detail Admin checkbox visible" });
  };
  await showAs(den.admin);
  expect(await checkboxState()).toEqual({ disabled: false, checked: false });
  await clickCheckbox();
  await eventually(async () => (await org(teammate)).currentMember.role, { within: 15_000, until: (role) => role === "member,admin", label: "owner checkbox saved Admin grant" });
  await eventually(checkboxState, { within: 15_000, until: (state) => state.checked && !state.disabled, label: "saved checkbox reloaded" });
  await showAs(teammate);
  expect(await checkboxState()).toEqual({ disabled: true, checked: true });
  await clickButton("Overview");
  await waitFor(browser, () => document.body.innerText.includes("Admin via UI Operations"), { timeoutMs: 15_000, label: "inherited role provenance visible" });
  expect((await org(teammate)).currentMember.directRole).toBe("member");
  for (const width of [1280, 390]) {
    await browser.client.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await waitFor(browser, browserScript((width) => window.innerWidth === width, [width]), { timeoutMs: 10_000, label: `viewport ${width}` });
    expect(await evalIn(browser, () => {
      const label = document.querySelector('input[type="checkbox"]')?.closest("label")?.getBoundingClientRect();
      return Boolean(label && label.left >= 0 && label.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth);
    }), `checkbox fits viewport ${width}`).toBe(true);
  }
  await showAs(den.admin);
  await clickCheckbox();
  await eventually(async () => (await org(teammate)).currentMember.role, { within: 15_000, until: (role) => role === "member", label: "owner unchecked Admin grant" });
  expect((await org(teammate)).currentMember.adminTeams).toEqual([]);
  evidence.recordAssertionEvidence("Team Admin checkbox persists grants and displays provenance without granting role management", "The owner checked and unchecked the real checkbox; API authority changed both times. The inherited admin saw it checked but disabled, saw Admin via UI Operations, and the control fit desktop and mobile viewports without horizontal overflow.", true);
});

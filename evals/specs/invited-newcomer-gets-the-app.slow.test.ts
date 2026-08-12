import { expect } from "vitest";
import { app, eventually, localMysqlIsRunning, needs, readDenClientState, server, test } from "@openwork/testkit";
import { denFetch, evalIn, go, signIn, waitFor, waitUntilInteractive } from "@openwork/behaviors";
import { isInteractive, navigate } from "@openwork/cdp";
import { screenshot } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "invited newcomer getting the app skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "invited newcomer getting the app skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "invited newcomer getting the app skipped — needs MySQL on 127.0.0.1:3306"
      : "an invited newcomer signs up, is offered a real installer, and ends up working in the app";

const PASSWORD = "OpenWorkEval123!";

function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const record: Record<string, unknown> = { ...value };
  const found = record[key];
  return typeof found === "string" ? found : "";
}

function readBooleanField(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return record[key] === true;
}

function readStringArray(value: unknown, key: string): string[] {
  if (typeof value !== "object" || value === null) return [];
  const record: Record<string, unknown> = { ...value };
  const found = record[key];
  if (!Array.isArray(found)) return [];
  return found.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Onboarding does not end when someone accepts an invitation. It ends when
 * they are working in OpenWork, and everything between those two points --
 * making an account on the invite, being handed an installer, opening the app
 * and finding their organization already there -- is where a new teammate is
 * actually lost. Other specs prove the halves: the web screens on one side, a
 * signed-in desktop on the other. This one refuses to skip the seam, and
 * photographs each step so the handoff can be reviewed rather than assumed.
 *
 * The installer link is checked by fetching whatever the screen offers. A
 * download the person cannot complete is the same as no download at all, and
 * the address is only known at render time, so it has to be read off the page.
 */
test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  const stamp = Date.now();
  const newcomerEmail = `newcomer-${stamp}@openwork.test`;

  await using den = await server({
    place,
    org: {
      name: "Northwind Robotics",
      admin: {
        email: `northwind-admin-${stamp}@openwork.test`,
        name: "Northwind Admin",
        password: PASSWORD,
      },
    },
  });

  const invited = await denFetch(den.ref, "/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ email: newcomerEmail, role: "member" }),
  });
  const inviteToken = readStringField(invited.body, "inviteToken");
  expect(inviteToken, `invite: HTTP ${invited.response.status} ${invited.text.slice(0, 300)}`).toBeTruthy();

  // Den's Better-Auth base URL is on localhost, and localhost and 127.0.0.1 do
  // not share cookies, so the browser stays on localhost for the whole visit.
  const webOrigin = den.ref.webUrl.replace("127.0.0.1", "localhost");
  await using browser = await chrome({ name: "newcomer", startUrl: webOrigin, headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate(browser.client, `${webOrigin}/join-org?invite=${encodeURIComponent(inviteToken)}`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="join-org-auth"] input'))`, {
    timeoutMs: 90_000,
    label: "invite sign-up step",
  });
  await screenshot(browser);

  const signedUp = String(await evalIn(browser, `(() => {
    const scope = document.querySelector('[data-testid="join-org-auth"]');
    if (!scope) return "no-form";
    const write = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = [...scope.querySelectorAll("input")];
    const describe = (input) => [input.name, input.id, input.placeholder ?? "", input.autocomplete ?? ""].join(" ");
    const name = inputs.find((input) => input.type !== "password" && /name/i.test(describe(input)));
    const password = inputs.find((input) => input.type === "password");
    if (name) write(name, "Nadia Newcomer");
    if (password) write(password, ${JSON.stringify(PASSWORD)});
    const submit = [...scope.querySelectorAll("button")]
      .find((candidate) => /create|sign ?up|continue|join/i.test(candidate.textContent ?? "") && !candidate.disabled);
    if (!submit) return "no-submit";
    submit.click();
    return "submitted";
  })()`));
  expect(signedUp).toBe("submitted");

  // Making the account does not join the organization. Den brings the new
  // account back to the invitation and still asks them to accept it.
  await waitFor(browser, `[...document.querySelectorAll("button")].some((button) => /^join /i.test((button.textContent ?? "").trim()))`, {
    timeoutMs: 120_000,
    label: "the invitation waiting for the new account to accept",
  });
  await screenshot(browser);

  const accepted = String(await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => /^join /i.test((candidate.textContent ?? "").trim()));
    if (!button) return "no-join-button";
    button.click();
    return "accepted";
  })()`));
  expect(accepted).toBe("accepted");

  await waitFor(browser, `/you're in|welcome to|get the desktop app|download openwork/i.test(document.body?.innerText ?? "")`, {
    timeoutMs: 120_000,
    label: "post-accept welcome screen",
  });
  await screenshot(browser);

  const welcome: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      welcomesThem: /you're in|welcome to/i.test(text),
      namesTheOrganization: text.includes("Northwind Robotics"),
      offersTheApp: /desktop app|download/i.test(text),
      downloadLinks: [...document.querySelectorAll('a[href]')]
        .map((anchor) => anchor.href)
        .filter((href) => /^https?:/.test(href) && /github\\.com|download|releases/i.test(href)),
      text: text.replace(/\\s+/g, " ").slice(0, 240),
    });
  })()`)));
  expect(readBooleanField(welcome, "welcomesThem")).toBe(true);
  expect(readBooleanField(welcome, "namesTheOrganization")).toBe(true);
  expect(readBooleanField(welcome, "offersTheApp")).toBe(true);
  evidence.fact(
    "Signing up on the invitation lands the newcomer on a welcome screen that offers the app",
    `After creating their account from the invite alone, the screen read: ${readStringField(welcome, "text")}`,
    true,
  );

  const downloadLinks = readStringArray(welcome, "downloadLinks");
  expect(downloadLinks.length, "The welcome screen offered no way to get the app.").toBeGreaterThan(0);
  const offered = downloadLinks[0] ?? "";
  const reachable = await fetch(offered, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
  expect(reachable.ok, `The offered download ${offered} answered HTTP ${reachable.status}.`).toBe(true);
  evidence.fact(
    "The download the welcome screen offers is a real one",
    `Following ${offered} answered HTTP ${reachable.status}, so the installer a new teammate is pointed at can actually be fetched.`,
    true,
  );

  // The desktop signs in as the person who just joined, so the harness needs a
  // session for the account the browser created rather than one it minted.
  den.members.newcomer = await signIn(den.ref, { email: newcomerEmail, password: PASSWORD });

  await using memberApp = await app({ den, as: "newcomer", place });
  const denState = await eventually(() => readDenClientState(memberApp), {
    within: 120_000,
    label: "the newcomer's organization in the app",
    until: (state) => Boolean(state.activeOrgId),
  });
  expect(denState.authTokenPresent).toBe(true);
  expect(denState.activeOrgId).toBeTruthy();
  expect(memberApp.workspaceId).toBeTruthy();

  const surface = await waitUntilInteractive(memberApp, { timeoutMs: 180_000 });
  expect(isInteractive(surface)).toBe(true);
  await screenshot(memberApp);
  evidence.fact(
    "Opening the app puts the newcomer straight to work",
    `The desktop app came up interactive on workspace ${memberApp.workspaceId} with the task screen, without the person configuring anything.`,
    true,
  );

  // The session shell never names the organization, so the tie that makes this
  // their team's copy of OpenWork is only legible on the Cloud account page.
  // The app canonicalises a bare /settings back to the workspace, hence both
  // the workspace-scoped route and the re-navigation on the way in.
  const accountRoute = `/workspace/${memberApp.workspaceId}/settings/cloud-account`;
  await go(memberApp, accountRoute);
  await waitFor(memberApp, `(() => {
    if (!window.location.hash.includes("/settings/cloud-account")) {
      window.location.hash = ${JSON.stringify(`#${accountRoute}`)};
      return false;
    }
    return document.body.innerText.includes("Northwind Robotics");
  })()`, {
    timeoutMs: 90_000,
    label: "the organization named inside the app",
  });
  await screenshot(memberApp);
  evidence.fact(
    "The app is signed in to the organization the invitation was for",
    `The app resolved organization ${denState.activeOrgName ?? denState.activeOrgId ?? "unknown"} on its own, and names Northwind Robotics on the account page.`,
    true,
  );
});

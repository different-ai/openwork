import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";
import { inviteMember, server, test } from "@openwork/testkit";
import { denFetch, evalIn, provisionOrg, signInInBrowser, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";

const run = promisify(execFile);

const airgapEnabled = process.env.OPENWORK_EVAL_KUBE_AIRGAP === "1";
const denApiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim() ?? "";
const kubeContext = process.env.OPENWORK_EVAL_KUBE_CONTEXT?.trim() || "kind-openwork-kube-lab";
const enabled = airgapEnabled && denApiUrl.length > 0;
const title = !airgapEnabled
  ? "invite screens on an airgapped cluster skipped — needs: OPENWORK_EVAL_KUBE_AIRGAP=1"
  : !denApiUrl
    ? "invite screens on an airgapped cluster skipped — needs: OPENWORK_EVAL_DEN_API_URL from the kube stack"
    : "invited people can join and reach the welcome screen while the cluster cannot reach the internet";

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

/** Ask the den-web pod itself whether it can still reach GitHub. */
async function githubReachableFromCluster(): Promise<boolean> {
  const script =
    "fetch('https://api.github.com/repos/different-ai/openwork/releases/latest',{signal:AbortSignal.timeout(12000)})" +
    ".then((r)=>console.log('REACHABLE',r.status)).catch(()=>console.log('BLOCKED'))";
  const { stdout } = await run("kubectl", [
    "--context",
    kubeContext,
    "exec",
    "deploy/openwork-ee-den-web",
    "--",
    "node",
    "-e",
    script,
  ]);
  return stdout.includes("REACHABLE");
}

/**
 * A self-hosted OpenWork on a locked-down corporate network: Den runs in
 * Kubernetes, in-cluster traffic works, and outbound internet does not. The
 * screens under test both depend on that boundary. The sign-up form has to
 * come up for someone who has no account yet, and the post-accept welcome
 * screen fetches desktop installers from GitHub, which is exactly the call
 * this network refuses. Photographing both screens is the point: the change
 * being proved is what a person sees after accepting an invite, and whether
 * a blocked release lookup quietly removes their way to get the app.
 */
test.skipIf(!enabled)(title, async ({ evidence, place }) => {
  const blockedBefore = !(await githubReachableFromCluster());
  expect(blockedBefore, "The cluster still reaches GitHub, so this is not an airgapped run.").toBe(true);

  // OPENWORK_EVAL_DEN_API_URL points this at the Den already running in the
  // cluster, so nothing is spawned locally and the screens under test are served
  // from behind the airgap.
  await using den = await server({ place });
  const stamp = Date.now();
  const joinerEmail = `airgap-join-member-${stamp}@acme.test`;
  const joiner = await inviteMember(den, "joiner", {
    email: joinerEmail,
    name: "Airgap Join Member",
    password: PASSWORD,
  });

  // A second organization is the only honest way to hold a real invitation
  // token for someone who already has an account: it lets this spec drive the
  // accepted-invite path, which is the branch that used to redirect.
  const secondOrg = await provisionOrg(den.ref, { members: [] });
  const newcomerEmail = `airgap-newcomer-${stamp}@acme.test`;
  const [newcomerInvite, joinerInvite] = await Promise.all([
    denFetch(den.ref, "/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${secondOrg.admin.token}` },
      body: JSON.stringify({ email: newcomerEmail, role: "member" }),
    }),
    denFetch(den.ref, "/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${secondOrg.admin.token}` },
      body: JSON.stringify({ email: joinerEmail, role: "member" }),
    }),
  ]);
  const newcomerToken = readStringField(newcomerInvite.body, "inviteToken");
  const joinerToken = readStringField(joinerInvite.body, "inviteToken");
  expect(newcomerToken, `newcomer invite: HTTP ${newcomerInvite.response.status}`).toBeTruthy();
  expect(joinerToken, `joiner invite: HTTP ${joinerInvite.response.status}`).toBeTruthy();

  const accepted = await denFetch(den.ref, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${joiner.token}` },
    body: JSON.stringify({ id: joinerToken }),
  });
  expect(accepted.response.ok, `accept: HTTP ${accepted.response.status}`).toBe(true);

  // The newcomer and the joiner are two different people, so they get two
  // browsers. Sharing one would carry the newcomer's pending invite into the
  // joiner's sign-in and land them on a "switch accounts" screen.
  await using browser = await chrome({
    name: "airgap-newcomer",
    startUrl: den.ref.webUrl,
    headless: true,
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate(browser.client, `${den.ref.webUrl}/join-org?invite=${encodeURIComponent(newcomerToken)}`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="join-org-auth"] input'))`, {
    timeoutMs: 90_000,
    label: "invite sign-in step",
  });
  await screenshot(browser);
  const inviteScreen: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const scope = document.querySelector('[data-testid="join-org-auth"]');
    const inputs = [...(scope?.querySelectorAll("input") ?? [])];
    const describe = (input) => [input.name, input.id, input.placeholder ?? "", input.autocomplete ?? ""].join(" ");
    const text = document.body.innerText;
    return JSON.stringify({
      invitesToJoin: /join /i.test(text),
      showsTheInvitedEmail: text.includes(${JSON.stringify(newcomerEmail)}),
      offersASignInStep: inputs.length > 0,
      stillCheckingSignInMethod: /checking the workspace sign-in method/i.test(text),
      asksForCode: inputs.some((input) => input.maxLength === 6 || /code|otp/i.test(describe(input))),
      text: text.replace(/\\s+/g, " ").slice(0, 220),
    });
  })()`)));
  expect(readBooleanField(inviteScreen, "invitesToJoin")).toBe(true);
  expect(readBooleanField(inviteScreen, "showsTheInvitedEmail")).toBe(true);
  expect(readBooleanField(inviteScreen, "offersASignInStep")).toBe(true);
  expect(readBooleanField(inviteScreen, "stillCheckingSignInMethod")).toBe(false);
  expect(readBooleanField(inviteScreen, "asksForCode")).toBe(false);
  evidence.fact(
    "An invited person with no account reaches a working sign-in step, not a stalled invite screen",
    `The invite screen rendered: ${readStringField(inviteScreen, "text")}`,
    true,
  );

  await using joinerBrowser = await chrome({
    name: "airgap-joiner",
    startUrl: den.ref.webUrl,
    headless: true,
  });
  await joinerBrowser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await signInInBrowser(joinerBrowser, den.ref.webUrl, { email: joinerEmail, password: PASSWORD });
  await navigate(joinerBrowser.client, `${den.ref.webUrl}/join-org?invite=${encodeURIComponent(joinerToken)}`);
  await waitFor(joinerBrowser, `/welcome to|you're in|get the desktop app|download/i.test(document.body?.innerText ?? "")`, {
    timeoutMs: 90_000,
    label: "post-accept welcome screen",
  });
  await screenshot(joinerBrowser);
  const welcome: unknown = JSON.parse(String(await evalIn(joinerBrowser, `(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      welcomesTheMember: /you're in|welcome/i.test(text),
      offersTheDesktopApp: /desktop app|download/i.test(text),
      showsDashboardNav: Boolean(document.querySelector('nav a[href*="/dashboard/"]')),
      text: text.replace(/\\s+/g, " ").slice(0, 220),
    });
  })()`)));
  expect(readBooleanField(welcome, "welcomesTheMember")).toBe(true);
  expect(readBooleanField(welcome, "offersTheDesktopApp")).toBe(true);
  expect(readBooleanField(welcome, "showsDashboardNav")).toBe(false);
  evidence.fact(
    "A blocked release lookup still leaves the member a way to get the desktop app",
    `With GitHub unreachable from the cluster, the welcome screen rendered: ${readStringField(welcome, "text")}`,
    true,
  );

  const landedPath = await evalIn(joinerBrowser, `window.location.pathname`);
  expect(landedPath).toBe("/join-org");
  evidence.fact(
    "Accepting an invite no longer drops the member on the dashboard",
    `After the accepted invite resolved, the browser stayed on ${landedPath} showing the welcome screen instead of redirecting to /dashboard.`,
    true,
  );

  const blockedAfter = !(await githubReachableFromCluster());
  evidence.fact(
    "Both invite screens rendered while the cluster had no route to GitHub",
    `A fetch to api.github.com from the den-web pod was refused before and after the run (blocked before: ${blockedBefore}, blocked after: ${blockedAfter}), so the desktop installer lookup on the welcome screen fell back instead of reaching the network.`,
    blockedBefore && blockedAfter,
  );
});

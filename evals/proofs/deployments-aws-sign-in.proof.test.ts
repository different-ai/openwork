import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACCOUNT_ID, DEPLOYMENT_NAME, PORTAL_HOST, PORTAL_URL, ROLE_NAME, deploymentsAwsSignInWorld } from "../worlds/deployments-aws-sign-in.ts";

const test = spec.world(deploymentsAwsSignInWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const account = ACCOUNT_ID.replace(/^(\d{4})(\d{4})(\d{4})$/, "$1 $2 $3");

test("an admin saves the company AWS sign-in once and the approval link then opens in the deployment's own account", async ({ world, user, probe, step, evidence }) => {
  const text = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());

  await step("before: Deployments with the feature off shows the earlier screen and no AWS sign-in", async () => {
    await user.see({ testId: "managed-deployment-row" }, { timeoutMs: 90_000 });
    const setting = await text('[data-testid="aws-sign-in-setting"]');
    const plain = await world.approvalUrl();
    await user.screenshot();
    const ok = setting.length === 0 && plain.startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/");
    evidence.recordAssertionEvidence("With the feature off there is no AWS sign-in setting and the approval link is the plain AWS console link", `AWS sign-in rows: ${setting.length}; approval link host: ${new URL(plain).host}`, ok);
    expect(ok).toBe(true);
  });

  await step("with the feature on, Deployments is a list and the deployment opens as its own page", async () => {
    await world.turnOnGuidedDeployments();
    await user.reload();
    await user.see({ testId: "aws-sign-in-setting" }, { timeoutMs: 90_000 });
    const rows = await text('[data-testid="managed-deployment-row"]');
    const setting = (await text('[data-testid="aws-sign-in-setting"]')).join(" ");
    await user.screenshot();
    const listed = rows.length === 1 && rows[0].includes(DEPLOYMENT_NAME) && rows[0].includes(account) && rows[0].includes("Awaiting AWS approval") && setting.includes("Not set");
    evidence.recordAssertionEvidence("The list shows the deployment with its account and state, and AWS sign-in as not set", `row: ${rows.join(" | ")}; setting: ${setting}`, listed);
    expect(listed).toBe(true);
    await user.click({ testId: "managed-deployment-row" });
    await user.see({ testId: "deployment-approve-link" }, { timeoutMs: 60_000 });
  });

  await step("without a saved sign-in, step 1 asks the person to sign in to the right AWS account themselves", async () => {
    const signIn = (await text('[data-testid="deployment-approve-sign-in"]')).join(" ");
    const href = (await probe.linkTargets('[data-testid="deployment-approve-link"]'))[0] ?? "";
    await user.screenshot();
    const ok = signIn.includes(`Sign in to AWS account ${account}`) && signIn.includes("Save your sign-in page") && href.startsWith("https://us-east-1.console.aws.amazon.com/");
    evidence.recordAssertionEvidence("Step 1 names the AWS account and offers to save the sign-in page; the approval button is the plain console link", `step 1: ${signIn}; button opens: ${href.slice(0, 60)}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: the admin saves only the access portal and AWS asks them to choose a role", async () => {
    await user.click({ testId: "aws-sign-in-open" });
    await user.see({ text: "Role name (optional)" });
    await user.type({ testId: "aws-sign-in-portal" }, PORTAL_URL);
    await user.screenshot();
    await user.click({ testId: "aws-sign-in-save" });
    await user.see({ text: `Signs in through ${PORTAL_HOST}` }, { timeoutMs: 60_000 });
    await user.reload();
    await user.see({ testId: "deployment-approve-link" }, { timeoutMs: 60_000 });
    const saved = await world.savedSignIn();
    const href = (await probe.linkTargets('[data-testid="deployment-approve-link"]'))[0] ?? "";
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    const signIn = (await text('[data-testid="deployment-approve-sign-in"]')).join(" ");
    await user.screenshot();
    const ok = saved?.portalUrl === PORTAL_URL && saved.roleName === null && href.startsWith(`${PORTAL_URL}/#/console?`)
      && !params.has("role_name") && params.get("account_id") === ACCOUNT_ID
      && (params.get("destination") ?? "").startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/")
      && signIn.includes("Choose role at sign-in");
    evidence.recordAssertionEvidence("Saving a portal without a role leaves role selection to AWS", `saved role: ${saved?.roleName}; row: ${signIn}; role parameter present: ${params.has("role_name")}; account: ${params.get("account_id")}`, ok);
    expect(ok).toBe(true);
  });

  await step("the admin can also save an exact role name", async () => {
    await user.click({ testId: "aws-sign-in-detail" });
    await user.see({ testId: "aws-sign-in-dialog" });
    await user.type({ testId: "aws-sign-in-role" }, ROLE_NAME);
    await user.screenshot();
    await user.click({ testId: "aws-sign-in-save" });
    await user.see({ text: `Account ${account} · ${ROLE_NAME}` }, { timeoutMs: 60_000 });
    const saved = await world.savedSignIn();
    const ok = saved?.portalUrl === PORTAL_URL && saved.roleName === ROLE_NAME;
    evidence.recordAssertionEvidence("Den saved the sign-in for the organization", `portal: ${saved?.portalUrl}; role: ${saved?.roleName}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: the same approval now opens through the portal, in the deployment's account and role", async () => {
    await user.see({ testId: "deployment-approve-link" }, { timeoutMs: 60_000 });
    const signIn = (await text('[data-testid="deployment-approve-sign-in"]')).join(" ");
    const href = (await probe.linkTargets('[data-testid="deployment-approve-link"]'))[0] ?? "";
    const issued = await world.approvalUrl();
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    await user.screenshot();
    const ok = href === issued && href.startsWith(`${PORTAL_URL}/#/console?`) && params.get("account_id") === ACCOUNT_ID && params.get("role_name") === ROLE_NAME
      && (params.get("destination") ?? "").startsWith("https://us-east-1.console.aws.amazon.com/cloudformation/") && signIn.includes(`Account ${account} · ${ROLE_NAME}`);
    evidence.recordAssertionEvidence("Review and approve in AWS opens the access portal with the account, the role and the filled-in CloudFormation page as its destination",
      `row: ${signIn}; link: ${href.slice(0, 48)}…; account_id=${params.get("account_id")}; role_name=${params.get("role_name")}; destination host: ${params.get("destination") ? new URL(params.get("destination") ?? "").host : "none"}; same as Den issues: ${href === issued}`, ok);
    expect(ok).toBe(true);
  });

  await step("what to do when AWS shows something else is one click away, and the list shows the saved sign-in", async () => {
    await user.click({ testId: "deployment-aws-help-toggle" });
    await user.see({ text: "A different account number in the top right" });
    await user.screenshot();
    await user.click({ text: "Deployments" });
    await user.see({ testId: "aws-sign-in-setting" }, { timeoutMs: 60_000 });
    const setting = (await text('[data-testid="aws-sign-in-setting"]')).join(" ");
    await user.screenshot();
    const ok = setting.includes(`${PORTAL_HOST} · ${ROLE_NAME}`);
    evidence.recordAssertionEvidence("Settings › AWS sign-in shows the saved portal and role", setting, ok);
    expect(ok).toBe(true);
  });
});

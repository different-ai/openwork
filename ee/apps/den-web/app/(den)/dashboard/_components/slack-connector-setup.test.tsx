import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { oauthRequestFields } from "./connector-sign-in-method";
import { SlackSetupChecklist } from "./slack-connector-setup-checks";
import {
  type SlackSetupInput,
  isSlackMcpUrl,
  slackAssistantStatus,
  slackCreateAppUrl,
  slackSetupProgress,
  slackSetupSteps,
  slackUserOAuthManifest,
} from "./slack-connector-setup";

const CALLBACK = "https://api.den.example/v1/mcp-connections/oauth/callback";
const SCOPES = ["search:read.public", "chat:write", "users:read"];

const fresh: SlackSetupInput = {
  callbackUrl: CALLBACK,
  scopes: SCOPES,
  appSaved: false,
  mcpConfirmed: false,
  signedIn: false,
  signingIn: false,
  signInError: null,
  accountLabel: null,
  readiness: null,
  checking: false,
  assistant: "hidden",
};

function step(input: Partial<SlackSetupInput>, id: string) {
  const found = slackSetupSteps({ ...fresh, ...input }).find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

function render(input: Partial<SlackSetupInput> = {}, mcpConfirmed = input.mcpConfirmed ?? false) {
  return renderToStaticMarkup(
    <SlackSetupChecklist
      steps={slackSetupSteps({ ...fresh, ...input })}
      callbackUrl={input.callbackUrl === undefined ? CALLBACK : input.callbackUrl}
      scopes={SCOPES}
      mcpConfirmed={mcpConfirmed}
      onConfirmMcp={() => undefined}
      oauthAppFields={<form data-testid="setup-oauth-app" />}
      onSignIn={() => undefined}
      onCheckAgain={() => undefined}
      checking={false}
    />,
  );
}

function statusOf(html: string, id: string) {
  return new RegExp(`data-testid="setup-check-${id}" data-status="([a-z]+)"`).exec(html)?.[1] ?? null;
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

test("the manifest is a user-OAuth Slack app with OpenWork's redirect URL, the connector's scopes and MCP on", () => {
  const manifest = slackUserOAuthManifest({ redirectUrl: CALLBACK, scopes: [...SCOPES, "chat:write"] });
  assert.deepEqual(manifest.oauth_config, { redirect_urls: [CALLBACK], scopes: { user: SCOPES } });
  assert.equal(manifest.settings.is_mcp_enabled, true);
  assert.equal("bot_user" in manifest, false, "no bot pieces; @openwork adds those itself");
  assert.equal(JSON.stringify(manifest).includes("bot"), false);
  const url = new URL(slackCreateAppUrl(manifest));
  assert.equal(`${url.origin}${url.pathname}`, "https://api.slack.com/apps");
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("manifest_json") ?? "{}"), manifest);
});

test("the Slack preset asks for exactly its own scopes, not everything the server advertises", () => {
  const discovery = {
    authentication: {
      kind: "oauth" as const,
      authorizationServers: [{ issuer: "https://mcp.slack.com", clientIdMetadataDocumentSupported: false }],
      requiredScopes: [],
      recommendedScopes: ["canvases:write", "files:write", ...SCOPES],
      refreshSupport: "unknown" as const,
      availableRegistrationMethods: ["pre_registered" as const],
      recommendedRegistrationMethod: "pre_registered" as const,
    },
  };
  assert.deepEqual(oauthRequestFields(discovery, { defaultOAuthScopes: SCOPES }).requestedScopes, SCOPES);
  assert.deepEqual(oauthRequestFields(discovery).requestedScopes, ["canvases:write", "files:write", ...SCOPES]);
  assert.equal(isSlackMcpUrl("https://mcp.slack.com/mcp"), true);
  assert.equal(isSlackMcpUrl("https://mcp.notion.com/mcp"), false);
});

test("a fresh setup: create the app, confirm MCP, paste credentials; sign-in waits", () => {
  const html = render();
  assert.equal(statusOf(html, "slack-app"), "current");
  assert.equal(statusOf(html, "slack-mcp"), "current");
  assert.equal(statusOf(html, "sign-in-method"), "current");
  assert.equal(statusOf(html, "sign-in"), "waiting");
  assert.equal(statusOf(html, "slack-assistant"), null, "the assistant step only shows when eligible");
  const order = [...html.matchAll(/data-testid="setup-check-([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["slack-app", "slack-mcp", "sign-in-method", "sign-in"]);
  assert.match(html, /<a [^>]*target="_blank" rel="noopener noreferrer" data-testid="slack-setup-create-app"/);
  assert.match(html, /href="https:\/\/api\.slack\.com\/apps\?new_app=1&amp;manifest_json=/);
  assert.match(html, /data-testid="slack-setup-existing-app"/);
  assert.ok(text(html).includes(CALLBACK), "the redirect URL is there to copy for an existing app");
  assert.match(text(html), /Not checked yet\./);
  assert.match(html, /data-testid="slack-setup-confirm-mcp"/);
  assert.match(html, /data-testid="setup-oauth-app"/);
  assert.doesNotMatch(html, /data-testid="slack-setup-sign-in"/);
  assert.deepEqual(slackSetupProgress(slackSetupSteps(fresh)), { step: 1, total: 4, done: false });
});

test("without a public API address the app step is locked and says who can fix it", () => {
  const app = step({ callbackUrl: null }, "slack-app");
  assert.equal(app.status, "blocked");
  assert.match(app.description, /Whoever runs OpenWork/);
  assert.deepEqual(app.offers, []);
  assert.equal(step({ callbackUrl: null }, "sign-in-method").status, "waiting");
  assert.doesNotMatch(render({ callbackUrl: null }), /slack-setup-create-app/);
});

test("credentials saved but MCP not confirmed: sign-in still waits", () => {
  assert.equal(step({ appSaved: true }, "slack-app").status, "done");
  assert.equal(step({ appSaved: true }, "sign-in-method").status, "done");
  assert.equal(step({ appSaved: true }, "sign-in").status, "waiting");
  const ready = step({ appSaved: true, mcpConfirmed: true }, "sign-in");
  assert.equal(ready.status, "current");
  assert.deepEqual(ready.offers, ["sign-in"]);
  const confirmed = step({ appSaved: true, mcpConfirmed: true }, "slack-mcp");
  assert.equal(confirmed.status, "done");
  assert.match(confirmed.description, /Not checked yet/, "a confirmation is not a verification");
  assert.match(render({ appSaved: true, mcpConfirmed: true }), /data-testid="slack-setup-sign-in"/);
});

test("after signing in the MCP step shows the real check: running, then ready", () => {
  const signedIn = { appSaved: true, mcpConfirmed: true, signedIn: true, accountLabel: "U0SYNTH" };
  assert.equal(step(signedIn, "slack-mcp").status, "running");
  assert.equal(step(signedIn, "sign-in").status, "running");
  const ready = { ...signedIn, readiness: { status: "ready" as const, failure: null, reason: null } };
  assert.equal(step(ready, "slack-mcp").status, "done");
  assert.match(step(ready, "slack-mcp").description, /Slack answered/);
  assert.equal(step(ready, "sign-in").status, "done");
  assert.match(step(ready, "sign-in").description, /As U0SYNTH\. Ready\./);
  assert.deepEqual(slackSetupProgress(slackSetupSteps({ ...fresh, ...ready })), { step: 4, total: 4, done: true });
});

test("Slack refusing MCP after a good sign-in fails the MCP step, with the fix and a re-check", () => {
  const refused = {
    appSaved: true,
    mcpConfirmed: true,
    signedIn: true,
    readiness: { status: "could_not_verify" as const, failure: "tools_unreadable" as const, reason: "The service answered but its tools couldn't be read." },
  };
  const mcp = step(refused, "slack-mcp");
  assert.equal(mcp.status, "failed");
  assert.match(mcp.description, /Slack refused MCP requests\. Turn it on in your Slack app, then check again\./);
  assert.deepEqual(mcp.offers, ["open-slack-apps", "check-again"]);
  assert.equal(step(refused, "sign-in").status, "blocked");
  const html = render(refused);
  assert.equal(statusOf(html, "slack-mcp"), "failed");
  assert.match(html, /data-testid="slack-setup-check-again"/);
  assert.match(html, /data-testid="slack-setup-open-apps"/);
  // Even without the admin's confirmation, a recorded failure is shown as a failure.
  assert.equal(step({ ...refused, mcpConfirmed: false }, "slack-mcp").status, "failed");
});

test("other failures stay on the sign-in step with their own next action", () => {
  const base = { appSaved: true, mcpConfirmed: true, signedIn: true };
  const rejected = step({ ...base, readiness: { status: "could_not_verify", failure: "sign_in_rejected", reason: null } }, "sign-in");
  assert.equal(rejected.status, "failed");
  assert.deepEqual(rejected.offers, ["sign-in-again"]);
  const timedOut = step({ ...base, readiness: { status: "could_not_verify", failure: "timed_out", reason: "The check timed out. Try again." } }, "sign-in");
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.description, "The check timed out. Try again.");
  assert.deepEqual(timedOut.offers, ["check-again"]);
  assert.equal(step({ ...base, readiness: { status: "could_not_verify", failure: "timed_out", reason: null } }, "slack-mcp").status, "done");
  const failedSignIn = step({ appSaved: true, mcpConfirmed: true, signInError: "Sign-in did not finish. Try again." }, "sign-in");
  assert.equal(failedSignIn.status, "failed");
  assert.deepEqual(failedSignIn.offers, ["sign-in"]);
});

test("the optional @openwork step appears only for an eligible connection and never counts", () => {
  assert.equal(slackAssistantStatus(null), "hidden");
  assert.equal(slackAssistantStatus({ eligible: false, runnerAvailable: true, installed: false }), "hidden");
  assert.equal(slackAssistantStatus({ eligible: true, runnerAvailable: false, installed: false }), "unavailable");
  assert.equal(slackAssistantStatus({ eligible: true, runnerAvailable: true, installed: false }), "waiting");
  assert.equal(slackAssistantStatus({ eligible: true, runnerAvailable: true, installed: true }), "installed");
  const waiting = render({ appSaved: true, assistant: "waiting" });
  assert.equal(statusOf(waiting, "slack-assistant"), "waiting");
  const locked = step({ appSaved: true, assistant: "unavailable" }, "slack-assistant");
  assert.equal(locked.status, "blocked");
  assert.match(locked.description, /Whoever runs it/);
  assert.equal(slackSetupProgress(slackSetupSteps({ ...fresh, assistant: "waiting" })).total, 4);
});

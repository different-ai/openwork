import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteModelAccessPreviewView } from "./invite-model-access-preview";

const render = (state: Parameters<typeof InviteModelAccessPreviewView>[0]["state"], teamName: string | null = null) => renderToStaticMarkup(<InviteModelAccessPreviewView state={state} teamName={teamName} />);

test("Preview is explicitly scoped and never promises working inference", () => {
  const html = render({ status: "configured", rows: [{ key: "grant", providerName: "OpenAI", groupName: "Shared", modelIds: ["gpt-model"], modelNames: ["GPT display name"], source: "team", state: "shared_configured" }] }, "Design");
  assert.match(html, /Everyone \+ Design/);
  assert.match(html, /GPT display name/);
  assert.doesNotMatch(html, /gpt-model/);
  assert.match(html, /Shared AI model access only/);
  assert.match(html, /Existing members may have other personal grants not shown here/);
  assert.match(html, /Shared credential configured/);
  assert.match(html, /From Design/);
  assert.match(html, /not a live model test/);
  assert.match(html, /Personal desktop keys are not shared/);
  assert.doesNotMatch(html, /Ready|ready to use/);
});

test("Unknown and error states do not block invites, and errors offer a non-submit retry", () => {
  const html = render({ status: "error", retry: () => undefined });
  assert.match(html, /could not be verified/);
  assert.match(html, /You can still send the invite/);
  assert.match(html, /Try again/);
  assert.match(html, /type="button"/);
  assert.match(render({ status: "unavailable" }), /could not be verified on this deployment/);
});

test("Locked, loading, empty and member sign-in states stay honest", () => {
  assert.match(render({ status: "locked" }), /Preview locked/);
  const checking = render({ status: "checking" });
  assert.match(checking, /aria-label="Checking shared model access"/);
  assert.doesNotMatch(checking, /No shared models/);
  assert.match(render({ status: "configured", rows: [] }), /No shared models configured for Everyone/);
  assert.match(render({ status: "configured", rows: [] }, "Design"), /No shared models configured for Everyone or Design/);
  assert.match(render({ status: "configured", rows: [{ key: "member", providerName: "Google", groupName: "Shared", modelIds: ["gemini-model"], modelNames: ["Gemini display name"], source: "everyone", state: "member_sign_in" }] }), /Member sign-in or setup pending/);
});

test("Large previews collapse and have a bounded, keyboard-accessible list; missing names never become raw IDs", () => {
  const html = render({ status: "configured", rows: Array.from({ length: 20 }, (_, i) => ({ key: String(i), providerName: "Provider", groupName: `Group ${i}`, modelIds: ["raw-internal-id"], modelNames: [null], source: "everyone", state: "shared_configured" })) });
  assert.match(html, /20 shared model groups/);
  assert.match(html, /<details data-testid="invite-model-access-details">/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /max-h-48/);
  assert.match(html, /overflow-y-auto/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /1 model name unavailable/);
  assert.doesNotMatch(html, /raw-internal-id/);
});

test("Unknown provider universe offers retry without claiming a configured model", () => {
  const html = render({ status: "configured", rows: [{ key: "unknown", providerName: "Provider", groupName: "Group", modelIds: [], modelNames: [], source: "everyone", state: "selection_unverified" }], retry: () => undefined });
  assert.match(html, /Model selection could not be verified/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Shared credential configured|No shared models/);
});

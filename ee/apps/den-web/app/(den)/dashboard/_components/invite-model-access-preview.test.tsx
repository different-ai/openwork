import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteModelAccessPreviewView } from "./invite-model-access-preview";

const render = (state: Parameters<typeof InviteModelAccessPreviewView>[0]["state"], teamName: string | null = null) => renderToStaticMarkup(<InviteModelAccessPreviewView state={state} teamName={teamName} />);

test("an admin sees which providers the invitee gets, scoped to Everyone and the chosen team, without a readiness promise", () => {
  const html = render({ status: "configured", rows: [{ key: "grant", providerName: "OpenAI", groupName: "Shared", modelIds: ["gpt-model"], modelNames: ["GPT display name"], source: "team", state: "shared_configured" }] }, "Design");
  assert.match(html, /Shared models/);
  assert.match(html, /Everyone \+ Design/);
  assert.match(html, /1 shared provider</);
  assert.match(html, /Shared key added/);
  assert.match(html, /1 model · Design/);
  assert.match(html, /GPT display name/);
  assert.doesNotMatch(html, /gpt-model/);
  assert.match(html, /aren&#x27;t shared by inviting them/);
  assert.doesNotMatch(html, /Ready|ready to use/);
});

test("errors never block the invite and retry without submitting", () => {
  const html = render({ status: "error", retry: () => undefined });
  assert.match(html, /You can still send the invite/);
  assert.match(html, /Try again/);
  assert.match(html, /type="button"/);
  assert.match(render({ status: "unavailable" }), /AI Gateway isn&#x27;t set up/);
});

test("someone who cannot view providers sees a lock with the reason; empty and pending states stay honest", () => {
  const locked = render({ status: "locked" });
  assert.match(locked, /lucide-lock/);
  assert.doesNotMatch(locked, /Shared key added|Try again/);
  assert.match(render({ status: "checking" }), /aria-label="Checking shared models"/);
  assert.match(render({ status: "configured", rows: [] }), /Nothing shared with Everyone yet/);
  assert.match(render({ status: "configured", rows: [] }, "Design"), /Nothing shared with Everyone \+ Design yet/);
  assert.match(render({ status: "configured", rows: [{ key: "member", providerName: "Google", groupName: "Shared", modelIds: ["gemini-model"], modelNames: ["Gemini display name"], source: "everyone", state: "member_sign_in" }] }), /Each person signs in/);
});

test("many providers collapse into a bounded keyboard list; missing names never become raw IDs", () => {
  const html = render({ status: "configured", rows: Array.from({ length: 20 }, (_, i) => ({ key: String(i), providerName: "Provider", groupName: `Group ${i}`, modelIds: ["raw-internal-id"], modelNames: [null], source: "everyone", state: "shared_configured" })) });
  assert.match(html, /20 shared providers/);
  assert.match(html, /<details data-testid="invite-model-access-details">/);
  assert.match(html, /max-h-48/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /1 model name unavailable/);
  assert.doesNotMatch(html, /raw-internal-id/);
});

test("an unverified model selection offers retry and claims nothing", () => {
  const html = render({ status: "configured", rows: [{ key: "unknown", providerName: "Provider", groupName: "Group", modelIds: [], modelNames: [], source: "everyone", state: "selection_unverified" }], retry: () => undefined });
  assert.match(html, /Couldn&#x27;t verify models/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Shared key added/);
});

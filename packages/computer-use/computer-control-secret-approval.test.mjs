// Approval of a saved browser secret: asked every time, named exactly, never standing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPUTER_PROTOCOL, createComputerControl } from "./computer-control.mjs";

const SITE = "https://app.example";
const SECRET = { label: "Billing sign-in", kind: "password", field: "password" };

function broker() {
  /** @type {Array<{ sessionId: string, request: import("./computer-control.mjs").ComputerRequest | null }>} */
  const shown = [];
  const control = createComputerControl({
    adapters: [{ id: "local", label: "This computer", placement: "local", protocol: COMPUTER_PROTOCOL,
      readiness: async () => ({ readiness: "ready", detail: "" }), connect: async () => { throw new Error("No app is opened in this test."); } }],
    onRequest: (sessionId, request) => { shown.push({ sessionId, request }); },
  });
  /** Starts an approval and resolves with the card it raised, once it is on screen. */
  const ask = async (input) => {
    const before = shown.length;
    const answer = control.approveCredential(input);
    for (let turn = 0; turn < 50 && shown.length === before; turn++) await new Promise((resolve) => setImmediate(resolve));
    return { answer, request: shown.at(-1)?.request ?? null, raised: shown.length > before };
  };
  return { control, shown, ask };
}

test("a secret's card names the label, kind, field and exact site, and offers nothing standing", async () => {
  const { control, ask } = broker();
  const { answer, request } = await ask({ sessionId: "chat", site: SITE, secret: SECRET });
  assert.equal(request?.reason, "credential");
  assert.equal(request?.standing, false);
  assert.deepEqual(request?.credential, { site: SITE, secret: SECRET });
  await control.answerRequest({ sessionId: "chat", answer: "allow", id: request.id });
  assert.equal(await answer, true);
});

test("declining a secret answers no", async () => {
  const { control, ask } = broker();
  const { answer, request } = await ask({ sessionId: "chat", site: SITE, secret: SECRET });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: request.id });
  assert.equal(await answer, false);
});

test("an always answer to a secret counts once: the next fill asks again", async () => {
  const { control, ask } = broker();
  const first = await ask({ sessionId: "chat", site: SITE, secret: SECRET });
  await control.answerRequest({ sessionId: "chat", answer: "always", id: first.request.id });
  assert.equal(await first.answer, true);
  const second = await ask({ sessionId: "chat", site: SITE, secret: SECRET });
  assert.equal(second.raised, true);
  assert.notEqual(second.request.id, first.request.id);
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: second.request.id });
  assert.equal(await second.answer, false);
  // Nor does it become a standing approval for typed credentials on that site.
  const typed = await ask({ sessionId: "chat", site: SITE });
  assert.equal(typed.raised, true);
  assert.deepEqual(typed.request.credential, { site: SITE });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: typed.request.id });
  assert.equal(await typed.answer, false);
});

test("always for typed credentials on a site never covers a secret there", async () => {
  const { control, ask } = broker();
  const typed = await ask({ sessionId: "chat", site: SITE });
  assert.equal(typed.request.standing, undefined);
  await control.answerRequest({ sessionId: "chat", answer: "always", id: typed.request.id });
  assert.equal(await typed.answer, true);
  // The standing approval holds for typed credentials: no card.
  const again = await ask({ sessionId: "chat", site: SITE });
  assert.equal(again.raised, false);
  assert.equal(await again.answer, true);
  // A secret on the same site still asks.
  const secret = await ask({ sessionId: "chat", site: SITE, secret: SECRET });
  assert.equal(secret.raised, true);
  assert.deepEqual(secret.request.credential, { site: SITE, secret: SECRET });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: secret.request.id });
  assert.equal(await secret.answer, false);
});

test("a secret that cannot be named whole is refused without asking", async () => {
  const { control, shown } = broker();
  const refused = [
    null,
    "Billing sign-in",
    {},
    { ...SECRET, label: "" },
    { ...SECRET, label: "   " },
    { ...SECRET, label: "x".repeat(81) },
    { ...SECRET, label: 7 },
    { ...SECRET, kind: "passphrase" },
    { ...SECRET, kind: undefined },
    { ...SECRET, field: "" },
    { ...SECRET, field: "x".repeat(33) },
    { label: SECRET.label, kind: SECRET.kind },
  ];
  for (const secret of refused) {
    assert.equal(await control.approveCredential({ sessionId: "chat", site: SITE, secret }), false, JSON.stringify(secret));
  }
  // A secret goes to an exact site, never a page address or an app.
  assert.equal(await control.approveCredential({ sessionId: "chat", site: `${SITE}/sign-in`, secret: SECRET }), false);
  assert.equal(await control.approveCredential({ sessionId: "chat", site: "app.example", secret: SECRET }), false);
  assert.equal(shown.length, 0);
});

test("the card carries only the label, kind and field of what it was given", async () => {
  const { control, ask } = broker();
  const { answer, request } = await ask({ sessionId: "chat", site: SITE, secret: { ...SECRET, secretRef: "sec_notShownOnTheCard00000", origins: [SITE] } });
  assert.deepEqual(request.credential, { site: SITE, secret: SECRET });
  await control.answerRequest({ sessionId: "chat", answer: "dismiss", id: request.id });
  assert.equal(await answer, false);
});

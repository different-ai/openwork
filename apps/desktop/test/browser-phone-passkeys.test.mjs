// Contract tests for passkeys from a phone in the built-in browser. These use
// a fake session emitter shaped like the upstream Electron events; they prove
// OpenWork's gating, tab binding and cleanup, not the phone or Bluetooth
// transport, which only a real phone and a hybrid-capable Electron can prove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  PHONE_PASSKEY_COMPLETED_EVENT,
  PHONE_PASSKEY_REQUEST_EVENT,
  PHONE_PASSKEY_UPDATE_EVENT,
  createBrowserPhonePasskeys,
  isPasskeyOrigin,
} from "../electron/browser-phone-passkeys.mjs";
import { phonePasskeyStateLine, renderPhonePasskeySheetHtml } from "../electron/phone-passkey-sheet.mjs";

const QR = `FIDO:/${"0123456789".repeat(20)}`;

function harness({ onScreen = new Set(["tab-1"]), owners = new Map([["tab-1", "ses-a"], ["tab-2", "ses-b"]]) } = {}) {
  const session = new EventEmitter();
  const frames = new Map();
  const sheets = [];
  const passkeys = createBrowserPhonePasskeys({
    getSession: () => session,
    tabForFrame: (frame) => frames.get(frame) ?? null,
    ownerOf: (tabId) => owners.get(tabId),
    isTabOnScreen: (tabId) => onScreen.has(tabId),
    openSheet: (view, actions) => {
      const sheet = { views: [view], actions, closed: false, update(next) { this.views.push(next); }, close() { this.closed = true; } };
      sheets.push(sheet);
      return sheet;
    },
  });
  function frame(tabId, { origin = "https://accounts.example.com", processId = 7, routingId = 1 } = {}) {
    const value = { origin, processId, routingId, detached: false };
    if (tabId) frames.set(value, { tabId });
    return value;
  }
  function request(details) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    session.emit(PHONE_PASSKEY_REQUEST_EVENT, event, details);
    return event;
  }
  return { session, passkeys, sheets, frame, request, onScreen, owners };
}

test("off by default: no listeners, so Electron never configures hybrid", () => {
  const { session, passkeys } = harness();
  assert.equal(session.listenerCount(PHONE_PASSKEY_REQUEST_EVENT), 0);
  assert.equal(passkeys.setEnabled(true), true);
  assert.equal(session.listenerCount(PHONE_PASSKEY_REQUEST_EVENT), 1);
  assert.equal(passkeys.setEnabled(true), true);
  assert.equal(session.listenerCount(PHONE_PASSKEY_REQUEST_EVENT), 1);
  passkeys.setEnabled(false);
  for (const name of [PHONE_PASSKEY_REQUEST_EVENT, PHONE_PASSKEY_UPDATE_EVENT, PHONE_PASSKEY_COMPLETED_EVENT]) {
    assert.equal(session.listenerCount(name), 0);
  }
});

test("shows Chromium's own QR payload over the on-screen tab that asked, and completes", () => {
  const { passkeys, sheets, frame, request, session } = harness();
  passkeys.setEnabled(true);
  const f = frame("tab-1");
  const event = request({ relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: f });
  assert.equal(event.prevented, true);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].views[0].qrCode, QR);
  assert.equal(sheets[0].views[0].origin, "https://accounts.example.com");
  assert.equal(sheets[0].views[0].canCancel, false);
  // What the host can list never carries the QR payload.
  assert.doesNotMatch(JSON.stringify(passkeys.pending()), /FIDO:/);
  assert.deepEqual(passkeys.pending(), [{ tabId: "tab-1", relyingPartyId: "example.com", requestType: "get", state: "waiting" }]);

  // Browser state broadcasts call refresh() often; the sheet is not redrawn.
  passkeys.refresh();
  passkeys.refresh();
  assert.equal(sheets[0].views.length, 1);
  session.emit(PHONE_PASSKEY_UPDATE_EVENT, {}, { frame: f, state: "phone-connected" });
  assert.equal(sheets[0].views.at(-1).state, "phone-connected");
  passkeys.refresh();
  session.emit(PHONE_PASSKEY_UPDATE_EVENT, {}, { frame: f, state: "made-up" });
  assert.equal(sheets[0].views.length, 2);

  // The frame is often gone at completion; one request for the RP still ends.
  session.emit(PHONE_PASSKEY_COMPLETED_EVENT, {}, { relyingPartyId: "example.com", frame: null });
  assert.equal(sheets[0].closed, true);
  assert.deepEqual(passkeys.pending(), []);
});

test("ignores anything that is not a real request from a browser tab", () => {
  const { passkeys, sheets, frame, request } = harness();
  passkeys.setEnabled(true);
  const cases = [
    { relyingPartyId: "example.com", requestType: "get", qrCode: "https://evil.example/qr", frame: frame("tab-1") },
    { relyingPartyId: "example.com", requestType: "get", qrCode: "FIDO:/12ab", frame: frame("tab-1") },
    { relyingPartyId: "example.com", requestType: "sign", qrCode: QR, frame: frame("tab-1") },
    { relyingPartyId: "exa mple.com", requestType: "get", qrCode: QR, frame: frame("tab-1") },
    { relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: null },
    { relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame(null) },
    { relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame("tab-1", { origin: "http://example.com" }) },
    { relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: { ...frame("tab-1"), detached: true } },
  ];
  for (const details of cases) assert.equal(request(details).prevented, false, JSON.stringify(details));
  assert.equal(sheets.length, 0);
  assert.deepEqual(passkeys.pending(), []);
});

test("a background tab waits: no sheet until the person opens it, and it ends with its owner", () => {
  const { passkeys, sheets, frame, request, onScreen, owners } = harness({ onScreen: new Set() });
  passkeys.setEnabled(true);
  request({ relyingPartyId: "example.com", requestType: "create", qrCode: QR, frame: frame("tab-2"), requestId: "r1" });
  assert.equal(sheets.length, 0);
  onScreen.add("tab-2");
  passkeys.refresh();
  assert.equal(sheets.length, 1);
  onScreen.delete("tab-2");
  passkeys.refresh();
  assert.equal(sheets[0].closed, true);
  assert.equal(passkeys.pending().length, 1);
  // Handed to another conversation: the request is cancelled, not followed.
  owners.set("tab-2", "ses-c");
  passkeys.refresh();
  assert.deepEqual(passkeys.pending(), []);
});

test("cancel ends the WebAuthn request when Electron offers cancel(), and closing the tab cancels", () => {
  const { passkeys, sheets, frame, request } = harness();
  passkeys.setEnabled(true);
  let cancelled = 0;
  request({ relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame("tab-1"), requestId: "r1", cancel: () => { cancelled += 1; } });
  assert.equal(sheets[0].views[0].canCancel, true);
  sheets[0].actions.cancel();
  assert.equal(cancelled, 1);
  assert.equal(sheets[0].closed, true);
  sheets[0].actions.cancel();
  assert.equal(cancelled, 1);

  request({ relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame("tab-1", { routingId: 2 }), requestId: "r2", cancel: () => { cancelled += 1; } });
  passkeys.tabClosed("tab-1");
  assert.equal(cancelled, 2);
  assert.deepEqual(passkeys.pending(), []);

  request({ relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame("tab-1", { routingId: 3 }), requestId: "r3", cancel: () => { cancelled += 1; } });
  passkeys.setEnabled(false);
  assert.equal(cancelled, 3);
});

test("one code per tab: a new request cancels and replaces the old one", () => {
  const { passkeys, sheets, frame, request } = harness();
  passkeys.setEnabled(true);
  let cancelledA = 0;
  request({ relyingPartyId: "example.com", requestType: "get", qrCode: QR, frame: frame("tab-1"), requestId: "a", cancel: () => { cancelledA += 1; } });
  request({ relyingPartyId: "example.com", requestType: "get", qrCode: `${QR}1`, frame: frame("tab-1", { routingId: 9 }), requestId: "b" });
  assert.equal(sheets[0].closed, true);
  assert.equal(cancelledA, 1);
  assert.equal(sheets[1].views[0].qrCode, `${QR}1`);
  assert.equal(passkeys.pending().length, 1);
});

test("secure origins only", () => {
  assert.equal(isPasskeyOrigin("https://example.com"), true);
  assert.equal(isPasskeyOrigin("http://localhost:3000"), true);
  assert.equal(isPasskeyOrigin("http://example.com"), false);
  assert.equal(isPasskeyOrigin("file:///etc"), false);
  assert.equal(isPasskeyOrigin("https://example.com/path"), false);
});

test("sheet renders a script-free page with the QR, who asked, and the state", () => {
  const html = renderPhonePasskeySheetHtml({ relyingPartyId: "example.com", requestType: "get", origin: "https://login.partner.test", qrCode: QR, state: "waiting", canCancel: true });
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<svg/);
  assert.match(html, /Sign in to example\.com with your phone/);
  assert.match(html, /Requested by https:\/\/login\.partner\.test/);
  assert.match(html, /openwork-passkey:cancel/);
  const own = renderPhonePasskeySheetHtml({ relyingPartyId: "example.com", requestType: "create", origin: "https://www.example.com", qrCode: QR, state: "bluetooth-off", canCancel: false });
  assert.doesNotMatch(own, /Requested by/);
  assert.match(own, /Save a passkey for example\.com on your phone/);
  assert.match(own, /Bluetooth is off/);
  assert.equal(phonePasskeyStateLine("bluetooth-permission-denied").text, "OpenWork can't use Bluetooth");
  const hostile = renderPhonePasskeySheetHtml({ relyingPartyId: "<b>x</b>", requestType: "get", origin: "https://a.test", qrCode: QR, state: "waiting", canCancel: false });
  assert.doesNotMatch(hostile, /<b>x<\/b>/);
});

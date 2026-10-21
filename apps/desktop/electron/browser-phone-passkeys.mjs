// Passkeys from a phone or tablet (WebAuthn hybrid transport) for the
// built-in browser, behind the `browserPhonePasskeys` feature.
//
// Chromium implements the whole hybrid ceremony: it generates the
// request-bound QR secret, tunnels to the phone, checks Bluetooth proximity,
// verifies the origin and relying party, and resolves the page's
// navigator.credentials promise. OpenWork only shows Chromium's own `FIDO:/`
// payload as a QR code, next to the tab that asked, and lets the person cancel.
// OpenWork never generates a QR payload, never sees or stores phone secrets,
// and never approves anything: approval happens on the phone.
//
// Stock Electron (43.x through 45.x) does not expose hybrid transport to apps,
// so these events never fire there and nothing changes. The events consumed
// here are the ones proposed upstream in electron/electron#53733, plus the
// request id, state updates and cancel() described in
// docs/browser-phone-passkeys.md. Hybrid is only configured for a request
// while a listener is attached, so the listeners are attached only while the
// feature is on.
//
// This module does not import Electron so it can be tested in plain Node.

export const PHONE_PASSKEY_REQUEST_EVENT = "webauthn-hybrid-request";
export const PHONE_PASSKEY_UPDATE_EVENT = "webauthn-hybrid-request-updated";
export const PHONE_PASSKEY_COMPLETED_EVENT = "webauthn-hybrid-request-completed";

// caBLE v2 QR payloads are "FIDO:/" followed by base-10 digits. Chromium's
// payload is a few hundred digits; anything else is not Chromium's.
const QR_PAYLOAD = /^FIDO:\/\d{1,1000}$/;
const RELYING_PARTY_ID = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/i;
const UPDATE_STATES = new Set(["phone-connected", "advert-received", "ready", "bluetooth-off", "bluetooth-permission-denied"]);

/** The origins WebAuthn runs in: https, or http on a loopback host. */
export function isPasskeyOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function frameKey(frame) {
  if (!frame || typeof frame !== "object") return null;
  const { processId, routingId } = frame;
  return Number.isInteger(processId) && Number.isInteger(routingId) ? `frame:${processId}:${routingId}` : null;
}

/**
 * @param {object} options
 * @param {() => import("node:events").EventEmitter | null} options.getSession The built-in browser's session.
 * @param {(frame: unknown) => { tabId: string } | null} options.tabForFrame The browser tab a frame belongs to, or null.
 * @param {(tabId: string) => string | null | undefined} options.ownerOf The conversation that owns a tab now.
 * @param {(tabId: string) => boolean} options.isTabOnScreen Whether the person is looking at that tab now.
 * @param {(view: PhonePasskeyView, actions: { cancel: () => void }) => { update: (view: PhonePasskeyView) => void, close: () => void }} options.openSheet
 */
export function createBrowserPhonePasskeys({ getSession, tabForFrame, ownerOf, isTabOnScreen, openSheet }) {
  /** @type {Map<string, PhonePasskeyRequest>} */
  const requests = new Map();
  let attachedSession = null;

  function viewOf(request) {
    return {
      relyingPartyId: request.relyingPartyId,
      requestType: request.requestType,
      origin: request.origin,
      qrCode: request.qrCode,
      state: request.state,
      canCancel: typeof request.cancel === "function",
    };
  }

  function showOrHide(request) {
    if (isTabOnScreen(request.tabId)) {
      // refresh() runs on every browser state change; redraw only on a new state.
      if (!request.sheet) request.sheet = openSheet(viewOf(request), { cancel: () => cancelRequest(request.key) });
      else if (request.sheetState !== request.state) request.sheet.update(viewOf(request));
      request.sheetState = request.state;
    } else if (request.sheet) {
      // The request keeps running; its code comes back with its tab.
      request.sheet.close();
      request.sheet = null;
    }
  }

  function end(key) {
    const request = requests.get(key);
    if (!request) return;
    requests.delete(key);
    request.sheet?.close();
    request.sheet = null;
  }

  function cancelRequest(key) {
    const request = requests.get(key);
    if (!request) return;
    // Electron builds with cancel() end the WebAuthn request, and the page
    // gets NotAllowedError. Without it the request stays open until the
    // page's timeout; closing the code means it can no longer be scanned here.
    try { request.cancel?.(); } catch { /* request already finished */ }
    end(key);
  }

  function onRequest(event, details) {
    if (!details || typeof details !== "object") return;
    const { relyingPartyId, requestType, qrCode, frame } = details;
    if (typeof qrCode !== "string" || !QR_PAYLOAD.test(qrCode)) return;
    if (requestType !== "get" && requestType !== "create") return;
    if (typeof relyingPartyId !== "string" || !RELYING_PARTY_ID.test(relyingPartyId)) return;
    if (!frame || frame.detached === true) return;
    const origin = typeof frame.origin === "string" ? frame.origin : "";
    if (!isPasskeyOrigin(origin)) return;
    const tab = tabForFrame(frame);
    if (!tab) return;
    const key = typeof details.requestId === "string" && details.requestId ? `request:${details.requestId}` : frameKey(frame);
    if (!key) return;
    // Accept the request: builds that ask apps to opt in configure hybrid
    // only when the listener prevents the default.
    event?.preventDefault?.();
    // A tab shows one code. Another frame's request in the same tab is
    // cancelled rather than left running without a code.
    for (const other of [...requests.values()]) {
      if (other.key === key) end(other.key);
      else if (other.tabId === tab.tabId) cancelRequest(other.key);
    }
    /** @type {PhonePasskeyRequest} */
    const request = {
      key,
      frameKey: frameKey(frame),
      tabId: tab.tabId,
      ownerSessionId: ownerOf(tab.tabId) ?? null,
      relyingPartyId: relyingPartyId.toLowerCase(),
      requestType,
      origin,
      qrCode,
      state: "waiting",
      cancel: typeof details.cancel === "function" ? details.cancel : null,
      sheet: null,
      sheetState: null,
    };
    requests.set(key, request);
    showOrHide(request);
  }

  function find(details) {
    if (!details || typeof details !== "object") return null;
    if (typeof details.requestId === "string" && details.requestId) return requests.get(`request:${details.requestId}`) ?? null;
    const key = frameKey(details.frame);
    if (key) return [...requests.values()].find((request) => request.frameKey === key) ?? null;
    // The frame is often gone when a request ends (navigation). Without a
    // request id, end the one request for that relying party, if only one.
    const matches = [...requests.values()].filter((request) => request.relyingPartyId === String(details.relyingPartyId ?? "").toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  }

  function onUpdate(_event, details) {
    const request = find(details);
    if (!request || !UPDATE_STATES.has(details.state)) return;
    request.state = details.state;
    showOrHide(request);
  }

  function onCompleted(_event, details) {
    const request = find(details);
    if (request) end(request.key);
  }

  function setEnabled(enabled) {
    if (enabled) {
      if (attachedSession) return true;
      const browserSession = getSession();
      if (!browserSession) return false;
      browserSession.on(PHONE_PASSKEY_REQUEST_EVENT, onRequest);
      browserSession.on(PHONE_PASSKEY_UPDATE_EVENT, onUpdate);
      browserSession.on(PHONE_PASSKEY_COMPLETED_EVENT, onCompleted);
      attachedSession = browserSession;
      return true;
    }
    if (attachedSession) {
      attachedSession.removeListener(PHONE_PASSKEY_REQUEST_EVENT, onRequest);
      attachedSession.removeListener(PHONE_PASSKEY_UPDATE_EVENT, onUpdate);
      attachedSession.removeListener(PHONE_PASSKEY_COMPLETED_EVENT, onCompleted);
      attachedSession = null;
    }
    // Turning the feature off cancels what is in flight.
    for (const key of [...requests.keys()]) cancelRequest(key);
    return false;
  }

  return {
    setEnabled,
    /** Call when tabs, conversations or panel visibility change. */
    refresh() {
      for (const request of [...requests.values()]) {
        // A tab handed to another conversation, or closed, takes its request with it.
        if ((ownerOf(request.tabId) ?? null) !== request.ownerSessionId) cancelRequest(request.key);
        else showOrHide(request);
      }
    },
    /** Call when a tab closes or changes owner: its request ends with it. */
    tabClosed(tabId) { for (const request of [...requests.values()]) if (request.tabId === tabId) cancelRequest(request.key); },
    /** In-flight requests, without their QR payloads. */
    pending() { return [...requests.values()].map((request) => ({ tabId: request.tabId, relyingPartyId: request.relyingPartyId, requestType: request.requestType, state: request.state })); },
  };
}

/**
 * @typedef {{ relyingPartyId: string, requestType: "get" | "create", origin: string, qrCode: string, state: string, canCancel: boolean }} PhonePasskeyView
 * @typedef {{ key: string, frameKey: string | null, tabId: string, ownerSessionId: string | null, relyingPartyId: string, requestType: "get" | "create", origin: string, qrCode: string, state: string, cancel: (() => void) | null, sheet: { update: (view: PhonePasskeyView) => void, close: () => void } | null, sheetState: string | null }} PhonePasskeyRequest
 */

import { randomUUID } from "node:crypto";
import { trustedComputerSender } from "./computer-control.mjs";

const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_MP3_BYTES = 2 * 1024 * 1024;
const FORMATS = new Set(["webm", "wav", "mp3", "m4a", "ogg"]);
const ERRORS = {
  voice_membership_required: "Voice requires an active OpenWork Models membership.",
  voice_quota_exhausted: "Your shared Models allowance is exhausted. Try again after it resets.",
  voice_invalid_request: "Use audio up to 3 MiB, or nonempty speech text up to 600 characters.",
  voice_payload_too_large: "The audio exceeds the size limit.",
  voice_timeout: "Voice request timed out.",
  voice_request_cancelled: "Voice request cancelled.",
  voice_sign_in: "Sign in to OpenWork to use voice.",
  voice_unavailable: "Voice is temporarily unavailable. Try again later.",
};
const failure = (code) => new Error(`${code}: ${ERRORS[code]}`);

function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

async function readBytes(response, signal, limit) {
  if (!response.body) throw failure("voice_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await withSignal(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw failure("voice_payload_too_large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } finally { void reader.cancel().catch(() => {}); }
}

function requestId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure("voice_invalid_request");
  return value;
}

/** No entitlement cache: every request uses the current native session and Den's gate. */
export function createVoice({ getSession, getBaseUrl, fetch: request = fetch, systemPreferences, platform = process.platform, timeoutMs = 80_000 }) {
  const pending = new Map();
  let revision = 0;
  let microphoneGranted = false;
  let microphonePending = false;
  function reset() {
    revision++;
    microphoneGranted = false;
    for (const controller of pending.values()) controller.abort();
  }
  async function call(id, path, body) {
    const session = getSession();
    if (!session) throw failure("voice_sign_in");
    if (session.baseUrl !== getBaseUrl()) throw failure("voice_unavailable");
    if (pending.has(id) || pending.size >= 4) throw failure("voice_unavailable");
    const controller = new AbortController();
    const deadline = new AbortController();
    const signal = AbortSignal.any([controller.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), path === "/v1/voice" ? Math.min(timeoutMs, 15_000) : timeoutMs);
    pending.set(id, controller);
    const currentRevision = revision;
    try {
      const response = await withSignal(request(`${session.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId,
          accept: path.endsWith("/speech") ? "audio/mpeg" : "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), signal);
      const bytes = await readBytes(response, signal, response.ok && path.endsWith("/speech") ? MAX_MP3_BYTES : 64 * 1024);
      signal.throwIfAborted();
      if (revision !== currentRevision || getSession() !== session) throw failure("voice_request_cancelled");
      if (!response.ok) {
        if (response.status === 401) throw failure("voice_sign_in");
        let payload;
        try { payload = JSON.parse(bytes.toString("utf8")); } catch { throw failure("voice_unavailable"); }
        const code = typeof payload?.error === "string" ? payload.error : payload?.error?.code;
        throw failure(Object.hasOwn(ERRORS, code) ? code : "voice_unavailable");
      }
      if (path.endsWith("/speech")) {
        if (!bytes.length || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "audio/mpeg") throw failure("voice_unavailable");
        return { data: bytes.toString("base64"), mimeType: "audio/mpeg" };
      }
      const payload = JSON.parse(bytes.toString("utf8"));
      if (path === "/v1/voice") {
        if (payload?.access === "ready") return { access: "ready" };
        if (payload?.access === "membership_required") return { access: "membership_required", message: ERRORS.voice_membership_required };
        return { access: "unavailable", message: ERRORS.voice_unavailable };
      }
      if (typeof payload?.text !== "string" || payload.text.length > 16000) throw failure("voice_unavailable");
      return { text: payload.text };
    } catch (error) {
      if (controller.signal.aborted) throw failure("voice_request_cancelled");
      if (deadline.signal.aborted) throw failure("voice_timeout");
      // Never pass a transport/provider error containing credentials or audio to IPC.
      const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
      throw failure(Object.hasOwn(ERRORS, code) ? code : "voice_unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
      pending.delete(id);
    }
  }
  return {
    reset,
    mediaAllowed: () => microphoneGranted,
    async status() {
      if (!getSession()) return { access: "sign_in", message: ERRORS.voice_sign_in };
      try { return await call(randomUUID(), "/v1/voice"); }
      catch (error) {
        if (error.message.startsWith("voice_sign_in:")) return { access: "sign_in", message: ERRORS.voice_sign_in };
        if (error.message.startsWith("voice_membership_required:")) return { access: "membership_required", message: ERRORS.voice_membership_required };
        return { access: "unavailable", message: ERRORS.voice_unavailable };
      }
    },
    async transcribe(input) {
      const id = requestId(input?.requestId);
      const data = input?.data;
      if (!FORMATS.has(input?.format) || typeof data !== "string" || !data.length || data.length > MAX_AUDIO_BYTES * 4 / 3
        || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw failure("voice_invalid_request");
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString("base64") !== data) throw failure("voice_invalid_request");
      return call(id, "/v1/voice/transcriptions", { input_audio: { data, format: input.format } });
    },
    async speech(input) {
      const id = requestId(input?.requestId);
      if (typeof input?.text !== "string" || !input.text.trim() || input.text.length > 600) throw failure("voice_invalid_request");
      return call(id, "/v1/voice/speech", { input: input.text });
    },
    async cancel(id) { pending.get(requestId(id))?.abort(); },
    async microphone() {
      if (microphonePending) return { granted: false };
      microphonePending = true;
      const currentRevision = revision;
      try {
        const status = platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted";
        const granted = status === "granted" || (status === "not-determined" && await systemPreferences.askForMediaAccess("microphone"));
        microphoneGranted = currentRevision === revision && granted === true;
        return { granted: microphoneGranted };
      } catch { microphoneGranted = false; return { granted: false }; }
      finally { microphonePending = false; }
    },
  };
}

export function installVoicePermissions(session, getWindow, getUrl, voice) {
  const allowed = (contents, permission, details) => {
    // Origin-only checks cannot establish frame identity; never infer it from the owning window.
    if (details?.isMainFrame !== true) return false;
    const expected = getWindow()?.webContents;
    if (!trustedComputerSender({ sender: contents, senderFrame: contents?.mainFrame }, expected, getUrl())) return false;
    try {
      const requested = new URL(details.requestingUrl);
      const actual = new URL(getUrl());
      requested.hash = ""; actual.hash = "";
      if (requested.href !== actual.href) return false;
    } catch { return false; }
    if (permission === "clipboard-sanitized-write") return true;
    if (!voice.mediaAllowed() || !["media", "audioCapture"].includes(permission)) return false;
    if (Array.isArray(details.mediaTypes) && details.mediaTypes.some((type) => type !== "audio")) return false;
    if (details.mediaType !== undefined) return details.mediaType === "audio";
    return Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === "audio");
  };
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details)));
  session.setPermissionCheckHandler((contents, permission, _origin, details) => allowed(contents, permission, details));
}

import { randomUUID } from "node:crypto";
import {
  clampSessionPowParams, DESKTOP_FREE_OPEN_API_KEY, DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_SESSION_PATH,
  DESKTOP_FREE_SESSION_POW_BITS, DESKTOP_FREE_SESSION_POW_ROUNDS, DESKTOP_FREE_SESSION_HEADER,
} from "@openwork/free-auto";
import { sha256Hex, startSessionPow } from "@openwork/free-auto/node";
import type { DesktopFreeSigner } from "../types.js";
import { externalFetch } from "../server-fetch.js";
import { isRecord, readJson, RemoteFailure, readBoundedBody, responseHeaders } from "./http.js";
import { ERROR_BODY_LIMIT, SESSION_TIMEOUT_MS } from "./settings.js";

type Grant = { token: string; expiresAt: number };

class DesktopSignerUnavailable extends Error {}

export class DesktopFreeSession {
  private pending?: { member: string | null; result: Promise<Grant> };
  private cached?: { member: string | null; grant: Grant };

  constructor(private signer: DesktopFreeSigner, private origin: string) {}

  private async mint(member: string | null, signal: AbortSignal): Promise<Grant> {
    const { machineId } = await this.signer.identity().catch(() => { throw new DesktopSignerUnavailable(); });
    let params: { bits: number; rounds: number } = { bits: DESKTOP_FREE_SESSION_POW_BITS, rounds: DESKTOP_FREE_SESSION_POW_ROUNDS };
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const nonce = randomUUID();
      const job = startSessionPow({ machineId, nonce, ...params });
      signal.addEventListener("abort", job.cancel, { once: true });
      let pow: string;
      try { pow = await job.promise; }
      finally { signal.removeEventListener("abort", job.cancel); }
      const body = new TextEncoder().encode(JSON.stringify({ pow, credentialHash: member ? sha256Hex(member) : undefined }));
      const proof = await this.signer.sign({ method: "POST", path: DESKTOP_FREE_SESSION_PATH, body, authorization: "", nonce }).catch(() => { throw new DesktopSignerUnavailable(); });
      const timed = AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]);
      const response = await externalFetch(this.origin + DESKTOP_FREE_SESSION_PATH, {
        method: "POST", headers: { [DESKTOP_FREE_PROOF_HEADER]: proof, "content-type": "application/json" },
        body, signal: timed, redirect: "error", credentials: "omit", cache: "no-store",
      });
      if (!response.ok) {
        const failure = new RemoteFailure(response.status, await readBoundedBody(response.body, ERROR_BODY_LIMIT, timed), responseHeaders(response.headers));
        const error = failure.payload();
        if (attempt === 0 && failure.status === 400 && error.code === "session_pow_required") {
          params = clampSessionPowParams({ bits: error.bits, rounds: error.rounds }, params);
          continue;
        }
        throw failure;
      }
      const grant = await readJson(response.body, ERROR_BODY_LIMIT, timed);
      if (!isRecord(grant) || typeof grant.token !== "string" || typeof grant.expiresAt !== "number" || grant.expiresAt <= Date.now()) {
        throw new Error("Invalid desktop free session");
      }
      return { token: grant.token, expiresAt: grant.expiresAt };
    }
    throw new Error("Desktop session verification failed");
  }

  async headers(member: string | null, path: string, method: string, body: Uint8Array, signal: AbortSignal, allowGuestFallback = false): Promise<Record<string, string>> {
    try { return await this.signedHeaders(member, path, method, body, signal); }
    catch (error) {
      signal.throwIfAborted();
      const unsupported = error instanceof RemoteFailure &&
        (error.status === 404 || error.status === 405 || (error.status === 503 && error.payload().code === "free_disabled"));
      if (member || !allowGuestFallback || !(error instanceof DesktopSignerUnavailable || unsupported)) throw error;
      return { authorization: `Bearer ${DESKTOP_FREE_OPEN_API_KEY}` };
    }
  }

  private async signedHeaders(member: string | null, path: string, method: string, body: Uint8Array, signal: AbortSignal) {
    let grant = this.cached?.member === member ? this.cached.grant : undefined;
    if (!grant || grant.expiresAt <= Date.now() + 5000) {
      if (this.pending?.member !== member) this.pending = { member, result: this.mint(member, signal) };
      const pending = this.pending;
      try {
        grant = await pending.result;
        signal.throwIfAborted();
        this.cached = { member, grant };
      } finally { if (this.pending === pending) this.pending = undefined; }
    }
    const authorization = member ?? `Bearer ${grant.token}`;
    const proof = await this.signer.sign({ method, path, body, authorization }).catch(() => { throw new DesktopSignerUnavailable(); });
    signal.throwIfAborted();
    return { authorization, [DESKTOP_FREE_PROOF_HEADER]: proof, ...(member ? { [DESKTOP_FREE_SESSION_HEADER]: grant.token } : {}) };
  }
}

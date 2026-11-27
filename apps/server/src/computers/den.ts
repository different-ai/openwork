import { z } from "zod";
import { computerAuthorizeResponseSchema, computerListResponseSchema, type ComputerAction } from "@openwork/types/den/computers";
import type { CloudProviderDenSession } from "../cloud-provider-sync.js";
import { externalFetch } from "../server-fetch.js";

const failureSchema = z.object({ code: z.string().optional(), error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional() });
export const computersUnavailable = "OpenWork couldn't check access to your computers. Try again when connected.";

type Status = "off" | "enabled" | "unavailable";
const ttl = { off: 300_000, enabled: 30_000 };

export function createComputersDen(getSession: () => CloudProviderDenSession | null, { now = Date.now, fetch = externalFetch } = {}) {
  let cache: { key: string; expires: number; status: "off" | "enabled" } | undefined;
  let pending: { key: string; promise: Promise<Status> } | undefined;
  const keyOf = (session: CloudProviderDenSession | null) => session && JSON.stringify([session.baseUrl, session.orgId, session.token]);

  async function request(path: string, action?: ComputerAction, signal?: AbortSignal) {
    const session = getSession();
    if (!session) return { status: "off" };
    const key = keyOf(session);
    const timeout = AbortSignal.timeout(3500);
    const response = await fetch(`${session.baseUrl}/v1/computers${path}`, {
      method: action ? "POST" : "GET", redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { Accept: "application/json", Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId, "Content-Type": "application/json" },
      ...(action ? { body: JSON.stringify({ action }) } : {}),
    });
    const payload: unknown = await response.json();
    if (keyOf(getSession()) !== key) throw new Error(computersUnavailable);
    if (response.ok) return { status: "ok", payload };
    const failure = failureSchema.safeParse(payload);
    const code = failure.success ? failure.data.code ?? (typeof failure.data.error === "string" ? failure.data.error : failure.data.error?.code) : undefined;
    if (response.status === 404 && code === "feature_disabled") {
      if (key) cache = { key, status: "off", expires: now() + ttl.off };
      pending = undefined;
      return { status: "off" };
    }
    if (response.status === 404 && code === "computer_not_found") return { status: "missing" };
    throw new Error(computersUnavailable);
  }
  const listComputers = async () => {
      try {
        const { status, payload } = await request("");
        if (status === "off") return { status: "off" } satisfies { status: "off" };
        if (status === "ok") return { status: "enabled", ...computerListResponseSchema.parse(payload) } satisfies { status: "enabled"; computers: unknown };
      } catch {
      }
      return { status: "unavailable" } satisfies { status: "unavailable" };
  };
  return {
    listComputers,
    status(): Promise<Status> {
      const key = keyOf(getSession());
      if (!key) {
        cache = undefined;
        pending = undefined;
        return Promise.resolve("off");
      }
      if (cache?.key === key && cache.expires > now()) return Promise.resolve(cache.status);
      if (pending?.key === key) return pending.promise;
      const promise: Promise<Status> = listComputers().then(({ status }) => {
        if (pending?.promise !== promise) return cache?.key === key && cache.expires > now() ? cache.status : "unavailable";
        pending = undefined;
        if (status !== "unavailable") cache = { key, status, expires: now() + ttl[status] };
        return status;
      });
      pending = { key, promise };
      return promise;
    },
    async authorize(computerId: string, action: ComputerAction, signal: AbortSignal) {
      let result;
      try { result = await request(`/${encodeURIComponent(computerId)}/authorize`, action, signal); }
      catch { throw new Error(computersUnavailable); }
      if (result.status === "missing") throw new Error("This chat's computer is no longer available to you.");
      if (result.status === "off") throw new Error("Running work on other computers is turned off. Nothing ran.");
      const parsed = computerAuthorizeResponseSchema.safeParse(result.payload);
      if (!parsed.success) throw new Error(computersUnavailable);
      return parsed.data;
    },
  };
}

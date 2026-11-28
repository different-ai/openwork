import { z } from "zod";
import { computerAuthorizeResponseSchema, computerExecutionSchema, computerListResponseSchema, computerSourceListResponseSchema, type ComputerAction, type ComputerToolCall } from "@openwork/types/den/computers";
import type { CloudProviderDenSession } from "../cloud-provider-sync.js";
import { externalFetch } from "../server-fetch.js";
import type { RunnerCredential } from "./runner-credential.js";

const failureSchema = z.object({ code: z.string().optional(), error: z.union([z.string(), z.object({ code: z.string().optional() })]).optional() });
export const computersUnavailable = "OpenWork couldn't check access to your computers. Try again when connected.";
export const computersConnecting = "This computer hasn't finished connecting to your organization yet. Try again in a moment. Nothing ran.";
const computersOff = "Running work on other computers is turned off. Nothing ran.";
export class ComputerQueueOff extends Error {
  constructor() { super(computersOff); }
}

type Status = "off" | "enabled" | "unavailable";
const ttl = { off: 300_000, enabled: 30_000 };
export const COMPUTER_QUEUE_WAIT_MS = 15_000;
export function createComputersDen(getSession: () => CloudProviderDenSession | null, {
  now = Date.now, fetch = externalFetch, runnerCredential = (): RunnerCredential | null => null,
} = {}) {
  let cache: { key: string; expires: number; status: "off" | "enabled" } | undefined;
  let pending: { key: string; promise: Promise<Status> } | undefined;
  const identity = () => {
    const runner = runnerCredential();
    if (runner) return { ...runner, prefix: "/v1/computer-sources", orgId: null };
    const session = getSession();
    return session && { ...session, prefix: "/v1", orgId: session.orgId };
  };
  const keyOf = (value: ReturnType<typeof identity>) => value && JSON.stringify([value.baseUrl, value.orgId, value.token]);

  async function request(session: ReturnType<typeof identity>, path: string, ms: number, body?: object, signal?: AbortSignal) {
    if (!session) return { status: "off" };
    const key = keyOf(session);
    const timeout = AbortSignal.timeout(ms);
    signal?.throwIfAborted();
    if (keyOf(identity()) !== key) throw new Error(computersUnavailable);
    const response = await fetch(`${session.baseUrl}${session.prefix}${path}`, {
      method: body ? "POST" : "GET", redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { Accept: "application/json", Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", ...(session.orgId ? { "x-openwork-org-id": session.orgId } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown = await response.json();
    if (keyOf(identity()) !== key) throw new Error(computersUnavailable);
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
      const session = identity();
      const { status, payload } = await request(session, "/computers", 3500);
      if (status === "off") return { status: "off" } satisfies { status: "off" };
      if (status === "ok") return {
        status: "enabled", self: null, ...(session?.orgId === null ? computerSourceListResponseSchema.parse(payload) : computerListResponseSchema.parse(payload)),
      } satisfies { status: "enabled"; self: unknown; computers: unknown };
    } catch {}
    return { status: "unavailable" } satisfies { status: "unavailable" };
  };
  return {
    listComputers,
    status(): Promise<Status> {
      const key = keyOf(identity());
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
      try { result = await request(identity(), `/computers/${encodeURIComponent(computerId)}/authorize`, 3500, { action }, signal); }
      catch { throw new Error(computersUnavailable); }
      if (result.status === "missing") throw new Error("This chat's computer is no longer available to you.");
      if (result.status === "off") throw new Error(computersOff);
      const parsed = computerAuthorizeResponseSchema.safeParse(result.payload);
      if (!parsed.success) throw new Error(computersUnavailable);
      return parsed.data;
    },
    sourceQueue() {
      const session = identity();
      if (!session || session.orgId !== null) return null;
      const waitMs = COMPUTER_QUEUE_WAIT_MS;
      const read = async (path: string, signal: AbortSignal, body?: object) => {
        const result = await request(session, path, waitMs + 5_000, body, signal);
        if (result.status === "off") throw new ComputerQueueOff();
        return computerExecutionSchema.parse(result.payload);
      };
      return {
        enqueue: (computerId: string, call: ComputerToolCall, signal: AbortSignal) => read(`/computers/${encodeURIComponent(computerId)}/commands`, signal, { call, waitMs }),
        follow: (id: string, signal: AbortSignal) => read(`/commands/${encodeURIComponent(id)}?waitMs=${waitMs}`, signal),
      };
    },
  };
}
export type ComputerSourceQueue = NonNullable<ReturnType<ReturnType<typeof createComputersDen>["sourceQueue"]>>;

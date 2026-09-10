import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { managedPolicyActionSchema, type ManagedPolicyAction } from "./managed-policy-rules.js";

const channel = "openwork.managed-policy";
const unavailable = "OpenWork policy service is unavailable.";
const maxPending = 256;
const requestSchema = z.object({
  channel: z.literal(channel),
  id: z.string().uuid(),
  action: managedPolicyActionSchema,
  input: z.record(z.string(), z.unknown()),
});
const responseSchema = z.object({
  channel: z.literal(channel),
  id: z.string().uuid(),
  error: z.string().nullable(),
});
export type ManagedPolicyCheck = (action: ManagedPolicyAction, input: Record<string, unknown>) => Promise<void>;

// Node's IPC descriptor belongs only to the spawned engine. It is not a
// listening socket, credential, or stdio stream inherited by shell children.
export function serveManagedPolicyIpc(child: ChildProcess, check: ManagedPolicyCheck): void {
  const pending = new Set<string>();
  const receive = async (message: unknown) => {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) return;
    const { id, action, input } = parsed.data;
    if (pending.has(id)) return;
    let error: string | null = null;
    if (pending.size >= maxPending) error = unavailable;
    else {
      pending.add(id);
      try { await check(action, input); }
      catch (cause) { error = cause instanceof Error ? cause.message : unavailable; }
      finally { pending.delete(id); }
    }
    if (child.connected) {
      // Disconnect can race an in-flight evaluation; never raise an unhandled
      // channel error or resume work in a replacement engine.
      try { child.send({ channel, id, error }, () => {}); } catch { /* closed */ }
    }
  };
  child.on("message", receive);
  child.once("disconnect", () => child.off("message", receive));
}

export function createManagedPolicyIpcClient(): ManagedPolicyCheck {
  const pending = new Map<string, (error: Error | null) => void>();
  const receive = (message: unknown) => {
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success) return;
    const { id, error } = parsed.data;
    pending.get(id)?.(error === null ? null : new Error(error));
  };
  const disconnect = () => {
    process.off("message", receive);
    for (const finish of pending.values()) finish(new Error(unavailable));
  };
  if (process.send) {
    process.on("message", receive);
    process.once("disconnect", disconnect);
  }
  return (action, input) => new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected || pending.size >= maxPending) {
      reject(new Error(unavailable));
      return;
    }
    const id = randomUUID();
    const finish = (error: Error | null) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(unavailable)), 15_000);
    pending.set(id, finish);
    try {
      process.send({ channel, id, action, input }, (error: Error | null) => {
        if (error) finish(new Error(unavailable));
      });
    } catch { finish(new Error(unavailable)); }
  });
}

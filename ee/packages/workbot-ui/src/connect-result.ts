import { z } from "zod";

const resultSchema = z.object({ type: z.literal("openwork:connection-result"), requestId: z.string().uuid(), connectionId: z.string(), ok: z.boolean() });

/** A completion packet is not proof of readiness; it is accepted only from this exact consent attempt. */
export function readConnectionResult(event: { source: unknown; origin: string; data: unknown }, expected: { popup: unknown; callbackOrigin: string | null; requestId: string; id: string }) {
  if (!expected.popup || event.source !== expected.popup || event.origin !== expected.callbackOrigin) return null;
  const parsed = resultSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.requestId !== expected.requestId || parsed.data.connectionId !== expected.id) return null;
  return parsed.data;
}

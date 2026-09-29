import { Rpc } from "@opencode-ai/plugin";
import { z } from "zod";

const page = { limit: z.number().int().min(1).max(200).optional(), before: z.string().optional() };
const reference = z.string().regex(/^v1:[a-f0-9]{24}:ses_[A-Za-z0-9]+$/);
const summary = z.object({ id: reference, projectID: z.string(), slug: z.string(), directory: z.string(), title: z.string(), version: z.string(),
  parentID: reference.optional(), time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
  legacyReference: z.object({ sourceID: z.string(), sessionID: z.string() }) });
const dictionary = z.record(z.string(), z.unknown());
const errors = { history: z.object({ code: z.string(), status: z.number() }) };
export const legacyRpc = Rpc.define({
  id: "openwork.legacy-history",
  methods: {
    list: { input: z.object({ ...page, search: z.string().optional() }).strict(), output: z.object({ data: z.array(summary), nextCursor: z.string().nullable() }), errors },
    read: { input: z.object({ ...page, reference }).strict(), output: z.object({ session: summary, data: z.array(z.object({ info: dictionary, parts: z.array(dictionary) })), nextCursor: z.string().nullable() }), errors },
    prepareImport: { input: z.object({ reference }).strict(), output: z.object({ sourceID: z.string(), sessionID: z.string(), homeDirectory: z.string(), converterVersion: z.string(),
      sessions: z.array(z.object({ info: z.object({ id: z.string(), metadata: dictionary }).catchall(z.unknown()), messages: z.array(dictionary), location: z.object({ directory: z.string() }) })),
      warnings: z.array(z.object({ sessionID: z.string(), reason: z.string(), message: z.string() })), resets: z.array(z.string()) }), errors },
  },
  events: {},
});

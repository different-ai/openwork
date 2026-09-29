import { Plugin } from "@opencode-ai/plugin";
import { createLegacyHistoryService, LegacyHistoryError } from "./service.mjs";
import { legacyRpc } from "./rpc.js";

export default Plugin.define({
  id: "openwork.legacy-history",
  async setup(context) {
    const source: unknown = context.options.legacyDatabase;
    if (typeof source !== "string") throw new Error("Configure legacyDatabase with the absolute v1 database path. Start v2 with a separate OPENCODE_DB before loading this plugin.");
    const service = createLegacyHistoryService({ legacyDatabase: source, targetDatabase: process.env.OPENCODE_DB });
    const directory = context.location.directory;
    const registration = await context.rpc.register(legacyRpc, {
      list: async (input, ctx) => {
        try { return await service.list({ ...input, directory }); }
        catch (error) { return ctx.error("history", error instanceof LegacyHistoryError ? error.message : "V1 history could not be read.", { code: error instanceof LegacyHistoryError ? error.code : "legacy_unavailable", status: error instanceof LegacyHistoryError ? error.status : 422 }); }
      },
      read: async (input, ctx) => {
        try { return await service.read({ ...input, directory }); }
        catch (error) { return ctx.error("history", error instanceof LegacyHistoryError ? error.message : "V1 history could not be read.", { code: error instanceof LegacyHistoryError ? error.code : "legacy_unavailable", status: error instanceof LegacyHistoryError ? error.status : 422 }); }
      },
      prepareImport: async (input, ctx) => {
        try { return await service.prepareImport({ ...input, directory }); }
        catch (error) { return ctx.error("history", error instanceof LegacyHistoryError ? error.message : "V1 history could not be converted. The original is unchanged.", { code: error instanceof LegacyHistoryError ? error.code : "legacy_unavailable", status: error instanceof LegacyHistoryError ? error.status : 422 }); }
      },
    });
    return () => registration.dispose();
  },
});

/**
 * Library entry point for the OpenWork server.
 *
 * Use this to embed the server in-process (e.g. inside Electron)
 * instead of running it as a standalone binary.
 *
 * ```ts
 * import { startServer } from "@openwork/server";
 *
 * const server = await startServer(config);
 * console.log(`Listening on port ${server.port}`);
 * ```
 */
export { startServer } from "./server.js";
export type { ServeResult } from "./serve-node.js";

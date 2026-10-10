import { readConfig } from "./config.js";
import { Store } from "./storage/store.js";
import { Pairing } from "./auth/pairing.js";
import { createServers } from "./server.js";
import type { OpenWorkAdapter } from "./adapters/types.js";
import type { Platform } from "./contract/index.js";

export interface BridgeOptions {
  adapter: OpenWorkAdapter;
  stateDirectory: string;
  platform: Platform;
  architecture: string;
  origin: string;
  remotePort?: number;
  admin?: boolean;
}

/** Embeddable lifecycle; does not install signal handlers or own the parent process. */
export async function startBridge(options: BridgeOptions) {
  const config = readConfig(["--origin", options.origin]);
  await options.adapter.health();
  const store = await Store.open(options.stateDirectory);
  let servers: ReturnType<typeof createServers> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const failures: unknown[] = [];
      if (servers) {
        servers.controls.close();
        for (const streams of servers.streams.values())
          for (const close of streams) close();
        const results = await Promise.allSettled([
          servers.hub.close(),
          servers.remote.close(),
          servers.admin.close(),
        ]);
        for (const result of results)
          if (result.status === "rejected") failures.push(result.reason);
      }
      try {
        await store.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "BRIDGE_STOP_FAILED");
    })());
  try {
    servers = createServers({
      store,
      pairing: new Pairing(store),
      adapter: options.adapter,
      platform: options.platform,
      architecture: options.architecture,
      origin: config.origin,
    });
    const address = await servers.remote.listen({
      host: "127.0.0.1",
      port: options.remotePort ?? config.remotePort,
    });
    const adminAddress = options.admin
      ? await servers.admin.listen({
          host: "127.0.0.1",
          port: config.adminPort,
        })
      : null;
    await servers.hub.start();
    return { address, adminAddress, controls: servers.controls, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "BRIDGE_START_FAILED");
    }
    throw error;
  }
}
export type BridgeRuntime = Awaited<ReturnType<typeof startBridge>>;

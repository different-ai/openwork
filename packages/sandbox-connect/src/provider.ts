import type { SandboxHandle, SandboxProvider } from "@openwork/sandbox";
import { connectSandboxCdp, type CdpConnectOptions } from "./cdp.ts";
import { connectSandboxPort, type ConnectOptions, type SandboxConnection } from "./connect.ts";

async function providerRoutes(provider: Pick<SandboxProvider, "id" | "blocks">, handle: SandboxHandle, port: number, timeoutMs: number) {
  const routes = provider.blocks?.routes;
  if (!routes) throw new Error(`The ${provider.id} adapter does not offer routes to guest ports`);
  return routes(handle, port, { timeoutMs });
}

/** Any provider, any guest port: the adapter lists routes, the first that passes `check` wins. */
export async function connectProviderPort(provider: Pick<SandboxProvider, "id" | "blocks">, handle: SandboxHandle, port: number, options: ConnectOptions): Promise<SandboxConnection> {
  return connectSandboxPort(await providerRoutes(provider, handle, port, 30_000), options);
}

/** Any provider's sandboxed browser as loopback CDP. */
export async function connectProviderCdp(provider: Pick<SandboxProvider, "id" | "blocks">, handle: SandboxHandle, port: number, options: CdpConnectOptions = {}): Promise<SandboxConnection> {
  return connectSandboxCdp(await providerRoutes(provider, handle, port, 30_000), options);
}

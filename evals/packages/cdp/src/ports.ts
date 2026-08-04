import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";

function portFromAddress(address: string | AddressInfo | null): number {
  if (typeof address === "object" && address !== null) return address.port;
  throw new Error("Allocated port server did not expose a TCP address.");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openPortServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    server.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      if (settled) return;
      settled = true;
      resolve({ server, port: portFromAddress(server.address()) });
    });
  });
}

export async function allocateFreePort(): Promise<number> {
  const { server, port } = await openPortServer();
  await closeServer(server);
  return port;
}

export async function allocateFreePorts(count: number): Promise<number[]> {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Port count must be a non-negative integer, got ${count}.`);
  }
  const opened: { server: Server; port: number }[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      opened.push(await openPortServer());
    }
    return opened.map((entry) => entry.port);
  } finally {
    await Promise.all(opened.map((entry) => closeServer(entry.server).catch(() => undefined)));
  }
}

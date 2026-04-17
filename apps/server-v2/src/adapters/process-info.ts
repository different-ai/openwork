import os from "node:os";

export type ProcessInfoAdapter = {
  environment: string;
  hostname: string;
  pid: number;
  platform: NodeJS.Platform;
  runtime: "bun";
  runtimeVersion: string | null;
};

export function createProcessInfoAdapter(environment: string = process.env.NODE_ENV ?? "development"): ProcessInfoAdapter {
  return {
    environment,
    hostname: os.hostname(),
    pid: process.pid,
    platform: process.platform,
    runtime: "bun",
    runtimeVersion: globalThis.Bun?.version ?? null,
  };
}

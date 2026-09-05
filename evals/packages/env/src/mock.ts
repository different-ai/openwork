import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "@openwork/labs";
import type { MockMcpHandle, StartMockMcpOptions } from "@openwork/labs";
import type { Place } from "./place.ts";

export type MockHandle = MockMcpHandle;

export interface MockUrls {
  name: string;
  url: string;
  mcpUrl: string;
}

export interface BootedMock {
  handle: MockHandle;
  env(urls: MockUrls): Record<string, string>;
}

export interface MockBoot {
  boot(place: Place): Promise<BootedMock>;
  daytonaPort?: number;
  allowUnauthenticatedMcp?: boolean;
  appToolName?: string;
  connect?(publicUrl: string): Promise<BootedMock>;
}

function mockEnvKey(name: string): string {
  const collapsed = [...name.trim().toUpperCase()]
    .map((ch) => (/[A-Z0-9]/.test(ch) ? ch : "_"))
    .join("")
    .split("_")
    .filter(Boolean)
    .join("_");
  return collapsed || "MOCK";
}

export function deriveMockEnv(name: string, url: string, mcpUrl: string): Record<string, string> {
  const key = mockEnvKey(name);
  return {
    [`OPENWORK_EVAL_MOCK_${key}_URL`]: url,
    [`OPENWORK_EVAL_MOCK_${key}_MCP_URL`]: mcpUrl,
  };
}

export function mcpMock(options: StartMockMcpOptions = {}): MockBoot {
  const boot = async (_place: Place): Promise<BootedMock> => {
    const port = options.port ?? await allocateFreePort();
    const handle = await startMockMcp({ ...options, port });
    return {
      handle,
      env: ({ name, url, mcpUrl }) => deriveMockEnv(name, url, mcpUrl),
    };
  };
  if (options.profileId) return { boot };
  return {
    daytonaPort: options.port ?? 3979,
    ...(options.allowUnauthenticatedMcp ? { allowUnauthenticatedMcp: true } : {}),
    ...(options.appToolName ? { appToolName: options.appToolName } : {}),
    async connect(publicUrl) {
      const handle = await startMockMcp({ ...options, publicUrl });
      return {
        handle,
        env: ({ name, url, mcpUrl }) => deriveMockEnv(name, url, mcpUrl),
      };
    },
    boot,
  };
}

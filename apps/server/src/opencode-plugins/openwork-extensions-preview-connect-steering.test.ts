import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  composeOpenWorkExtensionDiscoveryInstruction,
  OPENWORK_CLOUD_CONNECTION_INSTRUCTION,
  OPENWORK_CONNECT_GOOGLE_WORKSPACE_DISCONNECTED_INSTRUCTION,
  OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION,
  resetOpenWorkExtensionDiscoveryInstructionCacheForTests,
  resolveOpenWorkExtensionDiscoveryInstruction,
  type OpenWorkExtensionConnectState,
} from "./openwork-extensions-preview.js";

const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;

const UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check OpenWork extensions before saying the capability is unavailable. Use openwork_extension_list_actions to inspect available extension actions, then call the matching action with openwork_extension_call.";

const CLOUD_CONNECTION_INSTRUCTION =
  "The OpenWork Cloud connection is active. For email (Gmail), calendar, Google Drive, and org-connected services such as Notion, Linear, Slack, etc., FIRST call openwork-cloud_search_capabilities with 2-4 keyword variants, then call openwork-cloud_execute_capability with an exact returned name. Do not claim these are unavailable without searching. OpenWork extensions (openwork_extension_list_actions / openwork_extension_call) remain available for other local actions such as image generation, but do NOT use them for Google Workspace, and never direct the user to Settings > Extensions for Google Workspace; use Settings > Connect.";

const GOOGLE_WORKSPACE_DISCONNECTED_INSTRUCTION =
  `${UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION} Google Workspace is not connected on this device; if the user asks for email, calendar, or Google Drive, tell them to connect their account in Settings > Connect (never Settings > Extensions).`;

beforeEach(() => {
  resetOpenWorkExtensionDiscoveryInstructionCacheForTests();
});

afterEach(() => {
  resetOpenWorkExtensionDiscoveryInstructionCacheForTests();
  if (originalServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = originalServerToken;
});

describe("composeOpenWorkExtensionDiscoveryInstruction", () => {
  test("keeps the fallback instruction byte-identical when state is unavailable", () => {
    expect(OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeOpenWorkExtensionDiscoveryInstruction(null)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps the fallback instruction byte-identical when Connect is disabled", () => {
    const state: OpenWorkExtensionConnectState = {
      connectEnabled: false,
      cloudMcpPresent: true,
      googleWorkspace: { legacyConfigured: false },
    };

    expect(composeOpenWorkExtensionDiscoveryInstruction(state)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps the fallback instruction byte-identical when legacy Google Workspace is configured", () => {
    const state: OpenWorkExtensionConnectState = {
      connectEnabled: true,
      cloudMcpPresent: true,
      googleWorkspace: { legacyConfigured: true },
    };

    expect(composeOpenWorkExtensionDiscoveryInstruction(state)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("steers active Connect users to openwork-cloud capabilities first", () => {
    const state: OpenWorkExtensionConnectState = {
      connectEnabled: true,
      cloudMcpPresent: true,
      googleWorkspace: { legacyConfigured: false },
    };

    expect(OPENWORK_CLOUD_CONNECTION_INSTRUCTION).toBe(CLOUD_CONNECTION_INSTRUCTION);
    expect(composeOpenWorkExtensionDiscoveryInstruction(state)).toBe(CLOUD_CONNECTION_INSTRUCTION);
  });

  test("steers missing cloud MCP Google Workspace requests to Settings > Connect", () => {
    const state: OpenWorkExtensionConnectState = {
      connectEnabled: true,
      cloudMcpPresent: false,
      googleWorkspace: { legacyConfigured: false },
    };

    expect(OPENWORK_CONNECT_GOOGLE_WORKSPACE_DISCONNECTED_INSTRUCTION).toBe(GOOGLE_WORKSPACE_DISCONNECTED_INSTRUCTION);
    expect(composeOpenWorkExtensionDiscoveryInstruction(state)).toBe(GOOGLE_WORKSPACE_DISCONNECTED_INSTRUCTION);
  });
});

describe("resolveOpenWorkExtensionDiscoveryInstruction", () => {
  test("fetches connect state with bearer auth and caches the instruction for 15 seconds", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test/";
    process.env.OPENWORK_SERVER_TOKEN = "test-token";
    let now = 1_000;
    let calls = 0;
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      urls.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        cloudMcpPresent: true,
        googleWorkspace: { legacyConfigured: false },
      });
    };

    expect(await resolveOpenWorkExtensionDiscoveryInstruction(fakeFetch, () => now)).toBe(CLOUD_CONNECTION_INSTRUCTION);
    now += 14_999;
    expect(await resolveOpenWorkExtensionDiscoveryInstruction(fakeFetch, () => now)).toBe(CLOUD_CONNECTION_INSTRUCTION);
    expect(calls).toBe(1);

    now += 2;
    expect(await resolveOpenWorkExtensionDiscoveryInstruction(fakeFetch, () => now)).toBe(CLOUD_CONNECTION_INSTRUCTION);
    expect(calls).toBe(2);
    expect(urls).toEqual([
      "http://openwork.test/experimental/connect/state",
      "http://openwork.test/experimental/connect/state",
    ]);
    expect(authorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("fails open and caches the fallback instruction when fetching throws", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "test-token";
    let now = 2_000;
    let calls = 0;
    const failingFetch = async (): Promise<Response> => {
      calls += 1;
      throw new Error("network unavailable");
    };

    expect(await resolveOpenWorkExtensionDiscoveryInstruction(failingFetch, () => now)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    now += 1;
    expect(await resolveOpenWorkExtensionDiscoveryInstruction(failingFetch, () => now)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(calls).toBe(1);
  });

  test("fails open when connect state parsing fails", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "test-token";
    const invalidFetch = async (): Promise<Response> => Response.json({ ok: true });

    expect(await resolveOpenWorkExtensionDiscoveryInstruction(invalidFetch, () => 3_000)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});

import { describe, expect, test } from "bun:test";
import {
  OPENWORK_CLOUD_CONNECTION_INSTRUCTION,
  OPENWORK_CONNECT_DISABLED_INSTRUCTION,
  OPENWORK_CONNECT_SIGN_IN_INSTRUCTION,
  OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION,
} from "./openwork-extensions-preview-steering.js";
import {
  OPENWORK_AGENT_PROMPT,
  OPENWORK_BROWSER_INSTRUCTION,
  OPENWORK_CAPABILITIES_KNOWLEDGE,
  OPENWORK_SESSION_MEMORY_INSTRUCTION,
  OPENWORK_UI_CONTROL_INSTRUCTION,
} from "./openwork-system-instructions.js";

const instructions = {
  agent: OPENWORK_AGENT_PROMPT,
  product: OPENWORK_CAPABILITIES_KNOWLEDGE,
  extensions: OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION,
  connectReady: OPENWORK_CLOUD_CONNECTION_INSTRUCTION,
  connectSignIn: OPENWORK_CONNECT_SIGN_IN_INSTRUCTION,
  connectDisabled: OPENWORK_CONNECT_DISABLED_INSTRUCTION,
  sessions: OPENWORK_SESSION_MEMORY_INSTRUCTION,
  browser: OPENWORK_BROWSER_INSTRUCTION,
  ui: OPENWORK_UI_CONTROL_INSTRUCTION,
};

describe("OpenWork system instruction design", () => {
  test("keeps every OpenWork-owned instruction scoped and scannable", () => {
    for (const instruction of Object.values(instructions)) {
      expect(instruction).toStartWith("# ");
      expect(instruction).not.toMatch(/\b(?:ALWAYS|CRITICAL|FIRST)\b/);
    }

    const totalCharacters = Object.values(instructions).reduce((total, instruction) => total + instruction.length, 0);
    expect(totalCharacters).toBeLessThanOrEqual(4_000);
  });

  test("keeps product detail retrievable and live state conditional", () => {
    expect(OPENWORK_CAPABILITIES_KNOWLEDGE).toContain("openwork_docs_search");
    expect(OPENWORK_CAPABILITIES_KNOWLEDGE).not.toContain("https://api.openworklabs.com");
    expect(OPENWORK_CAPABILITIES_KNOWLEDGE).not.toContain("search_capabilities");
    expect(OPENWORK_CLOUD_CONNECTION_INSTRUCTION).toContain("openwork-cloud_search_capabilities");
    expect(OPENWORK_CLOUD_CONNECTION_INSTRUCTION).not.toContain("2-4 keyword variants");
  });

  test("assigns each cross-tool decision to one instruction", () => {
    expect(OPENWORK_UI_CONTROL_INSTRUCTION).toContain("openwork_ui_*");
    expect(OPENWORK_BROWSER_INSTRUCTION).toContain("openwork_browser_open_url");
    expect(OPENWORK_SESSION_MEMORY_INSTRUCTION).toContain("openwork_session_search");
    expect(OPENWORK_AGENT_PROMPT).not.toContain("openwork_ui_");
    expect(OPENWORK_CAPABILITIES_KNOWLEDGE).not.toContain("openwork_browser_open_url");
  });
});

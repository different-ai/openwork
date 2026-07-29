import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(appRoot, "../..");

describe("Station credential and development boundaries", () => {
  test("the renderer connects with an ephemeral client secret and never names the project key", async () => {
    const bridge = await Bun.file(resolve(
      appRoot,
      "src/react-app/domains/station/station-bridge.tsx",
    )).text();
    expect(bridge).toContain("apiKey: credentials.clientSecret");
    expect(bridge).not.toContain("OPENAI_API_KEY");
  });

  test("the production path captures a physical microphone and feeds it to Realtime WebRTC", async () => {
    const bridge = await Bun.file(resolve(
      appRoot,
      "src/react-app/domains/station/station-bridge.tsx",
    )).text();
    expect(bridge).toContain("navigator.mediaDevices.getUserMedia");
    expect(bridge).toContain("new OpenAIRealtimeWebRTC({ mediaStream: stream })");
    expect(bridge).toContain('inferenceMode: "openai-realtime"');
  });

  test("Station remains opt-in at both the preference and native lifecycle boundaries", async () => {
    const preferences = await Bun.file(resolve(
      appRoot,
      "src/react-app/kernel/local-provider.tsx",
    )).text();
    const manager = await Bun.file(resolve(
      repositoryRoot,
      "apps/desktop/electron/station-window.mjs",
    )).text();
    expect(preferences).toContain("station: false");
    expect(manager).toContain("let enabled = false");
    expect(manager).toContain('ipcMain.handle("openwork:station:set-enabled"');
  });

  test("local Station environment files are ignored", async () => {
    const gitignore = await Bun.file(resolve(repositoryRoot, ".gitignore")).text();
    expect(gitignore).toContain(".env*.local");
  });

  test("scenario mutation controls are registered only in development builds", async () => {
    const bridge = await Bun.file(resolve(
      appRoot,
      "src/react-app/domains/station/station-bridge.tsx",
    )).text();
    expect(bridge).toContain("useControlAction(import.meta.env.DEV ? runScenarioAction : null)");
    expect(bridge).toContain("useControlAction(import.meta.env.DEV ? resetScenarioAction : null)");
    expect(bridge).toContain("useControlAction(import.meta.env.DEV ? scenarioStatusAction : null)");
  });
});

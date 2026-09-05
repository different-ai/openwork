import { describe, expect, test } from "bun:test";

import type { DenExternalMcpPreset } from "../src/app/lib/den";
import {
  libraryConnectorCues,
  libraryConnectorIconUrls,
} from "../src/react-app/domains/settings/library-connector-cues";

function preset(
  presetId: string,
  displayName: string,
  url = `https://mcp.${presetId}.example/mcp`,
): DenExternalMcpPreset {
  return {
    presetId,
    displayName,
    description: `${displayName} connection`,
    url,
    authType: "oauth",
  };
}

describe("Library connector discovery cues", () => {
  test("prioritizes recognizable live Den presets alongside hosted suites", () => {
    const cues = libraryConnectorCues([
      preset("linear", "Linear"),
      preset("slack", "Slack"),
      preset("notion", "Notion"),
      preset("sentry", "Sentry"),
    ]);

    expect(cues.map((cue) => cue.name)).toEqual([
      "Notion",
      "Slack",
      "Google Workspace",
      "Microsoft 365",
      "Linear",
    ]);
    expect(cues[0]?.serviceUrl).toBe("https://mcp.notion.example/mcp");
    expect(cues).toHaveLength(5);
  });

  test("keeps hosted-service discovery useful when the live preset catalog is unavailable", () => {
    expect(libraryConnectorCues([]).map((cue) => cue.name)).toEqual([
      "Google Workspace",
      "Microsoft 365",
    ]);
  });

  test("deduplicates repeated presets before filling the compact cue strip", () => {
    const cues = libraryConnectorCues([
      preset("notion", "Old Notion"),
      preset("notion", "Notion"),
      preset("slack", "Slack"),
      preset("linear", "Linear"),
    ]);

    expect(cues.map((cue) => cue.name)).toEqual([
      "Notion",
      "Slack",
      "Google Workspace",
      "Microsoft 365",
      "Linear",
    ]);
  });

  test("falls back from unavailable catalog slugs to recognizable service favicons", () => {
    const cues = libraryConnectorCues([
      preset("slack", "Slack", "https://mcp.slack.com/mcp"),
    ]);
    const slack = cues.find((cue) => cue.id === "slack");
    const google = cues.find((cue) => cue.id === "google-workspace");
    const microsoft = cues.find((cue) => cue.id === "microsoft-365");

    expect(slack && libraryConnectorIconUrls(slack)).toEqual([
      "https://cdn.simpleicons.org/slack",
      "https://www.google.com/s2/favicons?sz=64&domain=slack.com",
    ]);
    expect(google && libraryConnectorIconUrls(google)).toEqual([
      "https://cdn.simpleicons.org/googleworkspace",
      "https://www.google.com/s2/favicons?sz=64&domain=google.com",
    ]);
    expect(microsoft && libraryConnectorIconUrls(microsoft)).toEqual([
      "https://cdn.simpleicons.org/microsoft365",
      "https://www.google.com/s2/favicons?sz=64&domain=microsoft365.com",
    ]);
  });
});

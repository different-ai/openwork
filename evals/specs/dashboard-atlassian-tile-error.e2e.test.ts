import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  atlassianDashboardTiles,
  confluenceTileTitle,
  expectedJql,
  jiraTileTitle,
} from "../worlds/dashboard-launch-input.ts";
import type { DashboardTileFacts } from "../worlds/dashboard-launch-input.ts";

/**
 * Customer report (2026-09): Dashboard tiles for the Atlassian remote MCP
 * "don't work" with the exact pasted JSON payloads, identically across an
 * org-account and an individual-accounts connection.
 *
 * Root cause: both payloads omit the required `cloudId` argument. Before the
 * fix every hop hid the provider's rejection and the tile read "Unexpected
 * server error".
 *
 * This spec drives the real Desktop dashboard tile against a deterministic
 * Atlassian-shaped witness MCP through a real Den connection proxy — no
 * fetch stubs — and asserts the member now sees the provider's own rejection
 * naming `cloudId` on the tile, never the generic 500 text. The witness proves
 * the pasted launch arguments arrived byte-identically.
 *
 * The witness is an inline loopback MCP server, so Den must run in the same
 * place — the same local-placement constraint remote-mcp-apps declares.
 */

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();

const test = spec.world(atlassianDashboardTiles, { timeout: 480_000 });

function requireTile(value: DashboardTileFacts | null, label: string): DashboardTileFacts {
  if (!value) throw new Error(`${label} tile was not rendered.`);
  return value;
}

test.skipIf(!localPlacement)(
  "a dashboard tile launched with the reported Atlassian JSON names the missing required argument",
  async ({ world, user, probe, evidence }) => {
    await probe.eventually(() => world.openDashboard(), {
      within: 90_000,
      label: "Dashboard navigation opened",
    });
    await probe.eventually(() => world.tilesReady(), {
      within: 90_000,
      label: "granted Atlassian dashboard tiles rendered with Run buttons",
    });

    // Launch both tiles exactly as the member does: press Run.
    world.receivedCalls.length = 0;
    await user.click({ role: "button", label: `Run ${confluenceTileTitle}` });
    await user.click({ role: "button", label: `Run ${jiraTileTitle}` });

    // What the member sees: the provider's rejection naming cloudId with the
    // failed-refresh badge, and never the pre-fix generic 500 text.
    await user.see({ text: /rejected the tool arguments/ }, { timeoutMs: 120_000 });
    await user.see({ text: /cloudId/ });
    await user.see({ text: /Refresh failed/ });
    await user.notSee({ text: /Unexpected server error/ });

    // Per-tile facts prove both tiles (not just one) carry that message.
    const tiles = await probe.eventually(() => world.tiles(), {
      within: 30_000,
      label: "both Atlassian tiles name the missing required argument",
      until: (value) => value.confluence?.namesCloudId === true && value.jql?.namesCloudId === true,
    });
    const confluenceTile = requireTile(tiles.confluence, confluenceTileTitle);
    const jqlTile = requireTile(tiles.jql, jiraTileTitle);

    // The launch still fails (cloudId is genuinely missing), but the member now
    // reads the provider's rejection naming the argument, not a generic 500.
    expect(confluenceTile.badgeFailed).toBe(true);
    expect(jqlTile.badgeFailed).toBe(true);
    expect(confluenceTile.namesCloudId).toBe(true);
    expect(jqlTile.namesCloudId).toBe(true);
    expect(confluenceTile.opaque).toBe(false);
    expect(jqlTile.opaque).toBe(false);
    expect(confluenceTile.text).toContain("rejected the tool arguments");
    expect(jqlTile.text).toContain("rejected the tool arguments");

    // The witness saw both launches with the pasted arguments byte-identical
    // and no cloudId — the provider rejection is the only failure in the chain.
    const witnessedByTool = new Map(world.receivedCalls.map((call) => [call.name, call.args]));
    expect(witnessedByTool.get("getConfluencePage")).toEqual({ pageId: "1122334455" });
    expect(witnessedByTool.get("searchJiraIssuesUsingJql")).toEqual({ jql: expectedJql });

    evidence.recordAssertionEvidence(
      "The dashboard tile names the missing required argument instead of a generic server error",
      `After Run, both tiles show the "Refresh failed" badge with the provider's rejection naming cloudId and never "Unexpected server error" (confluence=${JSON.stringify(confluenceTile)}, jql=${JSON.stringify(jqlTile)}).`,
      confluenceTile.namesCloudId && jqlTile.namesCloudId && !confluenceTile.opaque && !jqlTile.opaque,
    );
    evidence.recordAssertionEvidence(
      "The pasted launch JSON reached the provider intact",
      `The witness received getConfluencePage ${JSON.stringify(witnessedByTool.get("getConfluencePage"))} and searchJiraIssuesUsingJql with the exact single-escaped JQL string; the provider rejected both for the missing required cloudId with JSON-RPC -32602.`,
      JSON.stringify(witnessedByTool.get("searchJiraIssuesUsingJql")) === JSON.stringify({ jql: expectedJql }),
    );
  },
);

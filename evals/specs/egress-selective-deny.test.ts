import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { outboundManifestFromUnknown, startEgressLab } from "@openwork/labs";
import {
  diagnoseEgressLabProduct,
  productDiagnosticsPrecondition,
  readDeniedHostFacts,
} from "@openwork/behaviors";
import { matchVerdictExpectations } from "@openwork/matchers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "docs", "enterprise", "outbound-access.json");

describe("selective egress deny", () => {
  test("returns an actionable blocked-host response backed by the outbound manifest", async () => {
    await using lab = await startEgressLab({ profile: "deny", denyHosts: ["github.com", "127.0.0.1"] });
    const denied = await readDeniedHostFacts(lab);
    const manifest = outboundManifestFromUnknown(JSON.parse(await readFile(manifestPath, "utf8")));
    const manifestEntry = manifest?.hosts.find((entry) => entry.host === "github.com");

    expect(denied.status).toBe(451);
    expect(denied.errorCode).toBe("EGRESS_HOST_BLOCKED");
    expect(denied.host).toBe("github.com");
    expect(denied.text).toContain("docs/enterprise/outbound-access.json");
    expect(manifestEntry?.host).toBe("github.com");
    expect(manifestEntry?.blockedEffect).toMatch(/install|update|download/i);
  });

  const skipReason = productDiagnosticsPrecondition(process.env);
  test.skipIf(skipReason !== null)(
    skipReason ? `product diagnostics skipped: ${skipReason}` : "product diagnostics classify the HTTP 451 allowlist deny",
    async () => {
      await using lab = await startEgressLab({ profile: "deny", denyHosts: ["github.com", "127.0.0.1"] });
      const product = await diagnoseEgressLabProduct(lab);

      expect(product.available).toBe(true);
      expect(matchVerdictExpectations(product.text, "deny").ok).toBe(true);
    },
  );
});

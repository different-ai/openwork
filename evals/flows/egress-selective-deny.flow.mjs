import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEgressLab } from "../runner/labs/egress.mjs";
import { expectVerdictNames, productDiagnosticsPrecondition } from "../runner/journeys/diagnostics.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "egress-selective-deny";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = join(ROOT, "docs", "enterprise", "outbound-access.json");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

async function fetchDenied(lab) {
  const url = new URL("/fetch", lab.url);
  url.searchParams.set("url", "https://github.com/different-ai/openwork/releases/latest");
  const response = await fetch(url);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

export default {
  id: FLOW_ID,
  title: "Selective host blocks surface as actionable allowlist failures",
  kind: "internal",
  requiresApp: false,
  precondition: (ctx) => productDiagnosticsPrecondition(ctx.env),
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let lab;
        let denied;
        let manifest;
        await ctx.prove("github.com is blocked by policy, the lab error names the host, and OpenWork product diagnostics classify the HTTP 451 allowlist deny", {
          voiceover: vo[0],
          action: async () => {
            lab = await startEgressLab({ profile: "deny", denyHosts: ["github.com", "127.0.0.1"] });
            denied = await fetchDenied(lab);
            manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
          },
          assert: async () => {
            try {
              const manifestEntry = manifest.hosts.find((entry) => entry.host === "github.com");
              ctx.output("Selective deny response", JSON.stringify(denied, null, 2));
              ctx.output("github.com outbound manifest entry", JSON.stringify(manifestEntry, null, 2));
              witness(ctx, denied.status === 451, "github.com fails with an explicit blocked-host HTTP status", JSON.stringify(denied));
              witness(ctx, denied.json?.error === "EGRESS_HOST_BLOCKED", "the failure has a stable EGRESS_HOST_BLOCKED code", JSON.stringify(denied));
              witness(ctx, denied.json?.host === "github.com", "the failure names the blocked host", JSON.stringify(denied));
              witness(ctx, denied.text.includes("docs/enterprise/outbound-access.json"), "the error points operators at the allowlist manifest", denied.text);
              witness(ctx, manifestEntry?.host === "github.com" && /install|update|download/i.test(manifestEntry.blockedEffect), "the allowlist manifest names github.com and its installer/update blocked effect", JSON.stringify(manifestEntry));
              await expectVerdictNames(ctx, { lab, expect: "deny" });
            } finally {
              await lab?.stop();
            }
          },
        });
      },
    },
  ],
};

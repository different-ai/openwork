import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/helm-custom-ca.md).
// The runner fails this flow if the narration drifts from that script.
const FLOW_ID = "helm-custom-ca";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHART = join(ROOT, "packaging", "helm", "openwork-ee");
const MYSQL_TLS_TEST = join(CHART, "tests", "custom-ca-mysql-tls.mjs");
const CUSTOM_CA_PATH = "/etc/openwork/custom-ca/ca-bundle.pem";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function helmTemplate(args) {
  return run("helm", ["template", "openwork-ee", CHART, ...args]);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function selectedLines(text, needles) {
  return text
    .split("\n")
    .filter((line) => needles.some((needle) => line.includes(needle)))
    .join("\n");
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion);
}

function failureSummary(results) {
  return results
    .map((result) => `${result.name}: status=${result.status}\n${result.stderr.trim()}`)
    .join("\n\n");
}

export default {
  id: FLOW_ID,
  title: "Helm custom CA support reaches every Node workload without changing defaults",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let rendered = "";
        const valuesSnippet = `customCa:
  enabled: true
  existingSecret: openwork-ca-secret
  existingConfigMap: ""
  key: corp-root.pem`;
        await ctx.prove("Operators reference an existing CA Secret without embedding PEM material in Helm values", {
          voiceover: vo[0],
          action: async () => {
            const result = helmTemplate([
              "--set",
              "customCa.enabled=true",
              "--set",
              "customCa.existingSecret=openwork-ca-secret",
              "--set",
              "customCa.key=corp-root.pem",
            ]);
            witness(ctx, result.status === 0, "helm template succeeds with a Secret-backed custom CA", result.stderr.trim());
            rendered = result.stdout;
          },
          assert: async () => {
            witness(ctx, rendered.includes('secretName: "openwork-ca-secret"'), "The rendered volume references the existing Secret by name");
            witness(ctx, rendered.includes('key: "corp-root.pem"'), "The rendered volume selects the configured Secret key");
            witness(ctx, !valuesSnippet.includes("-----BEGIN CERTIFICATE-----"), "The values snippet contains no PEM certificate material");
            ctx.output("Secret-backed values", valuesSnippet);
            ctx.output(
              "Rendered Secret source",
              selectedLines(rendered, ["custom-ca", "secretName", "corp-root.pem", "ca-bundle.pem"]),
            );
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        let rendered = "";
        await ctx.prove("The selected CA key is mounted read-only into every Helm-managed Node workload", {
          voiceover: vo[1],
          action: async () => {
            const result = helmTemplate([
              "--set",
              "inference.enabled=true",
              "--set",
              "customCa.enabled=true",
              "--set",
              "customCa.existingSecret=openwork-ca-secret",
            ]);
            witness(ctx, result.status === 0, "helm template succeeds with inference enabled", result.stderr.trim());
            rendered = result.stdout;
          },
          assert: async () => {
            witness(ctx, rendered.includes("name: openwork-ee-den-api"), "Den API renders");
            witness(ctx, rendered.includes("name: openwork-ee-den-web"), "Den Web renders");
            witness(ctx, rendered.includes("name: openwork-ee-inference"), "Inference renders when enabled");
            witness(ctx, rendered.includes("name: openwork-ee-migrate"), "The migration Job renders");
            witness(ctx, countOccurrences(rendered, 'mountPath: "/etc/openwork/custom-ca"') === 4, "All four workloads mount the chart-controlled CA directory");
            witness(ctx, countOccurrences(rendered, "readOnly: true") >= 4, "The custom CA mount is read-only in every workload");
            witness(ctx, countOccurrences(rendered, "path: ca-bundle.pem") === 4, "Only the selected key is projected to ca-bundle.pem");
            witness(ctx, !rendered.includes("subPath:"), "The custom CA mount does not use subPath");
            ctx.output(
              "Rendered read-only mounts",
              selectedLines(rendered, ["openwork-ee-den-api", "openwork-ee-den-web", "openwork-ee-inference", "openwork-ee-migrate", "custom-ca", "mountPath", "readOnly", "ca-bundle.pem", "subPath"]),
            );
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        let rendered = "";
        await ctx.prove("Every rendered Node workload receives NODE_EXTRA_CA_CERTS pointing at the mounted CA file", {
          voiceover: vo[2],
          action: async () => {
            const result = helmTemplate([
              "--set",
              "inference.enabled=true",
              "--set",
              "customCa.enabled=true",
              "--set",
              "customCa.existingConfigMap=openwork-ca-config",
            ]);
            witness(ctx, result.status === 0, "helm template succeeds with a ConfigMap-backed custom CA", result.stderr.trim());
            rendered = result.stdout;
          },
          assert: async () => {
            witness(ctx, countOccurrences(rendered, "name: NODE_EXTRA_CA_CERTS") === 4, "All four Node workloads receive NODE_EXTRA_CA_CERTS");
            witness(ctx, countOccurrences(rendered, `value: "${CUSTOM_CA_PATH}"`) === 4, "NODE_EXTRA_CA_CERTS uses the chart-controlled file path");
            witness(ctx, rendered.includes('name: "openwork-ca-config"'), "The ConfigMap source is rendered when selected");
            ctx.output(
              "Rendered NODE_EXTRA_CA_CERTS",
              selectedLines(rendered, ["NODE_EXTRA_CA_CERTS", CUSTOM_CA_PATH, "openwork-ca-config"]),
            );
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        let output = "";
        await ctx.prove("The actual migration bootstrap and an OpenWork/mysql2 query connect to a strict-TLS MySQL endpoint signed by the private CA", {
          voiceover: vo[3],
          action: async () => {
            const result = run("node", [MYSQL_TLS_TEST]);
            output = `${result.stdout}\n${result.stderr}`.trim();
            witness(ctx, result.status === 0, "The MySQL TLS integration test exits successfully", output);
          },
          assert: async () => {
            witness(ctx, output.includes("Generated private CA and MySQL server certificate"), "The test generates the private CA and matching MySQL server certificate");
            witness(ctx, output.includes("Strict OpenWork/mysql2 without custom CA: rejected"), "Strict OpenWork/mysql2 connection fails without the custom CA");
            witness(ctx, output.includes("OpenWork migration bootstrap completed with NODE_EXTRA_CA_CERTS and strict DATABASE_URL"), "The actual OpenWork migration bootstrap completes with the mounted custom CA");
            witness(ctx, output.includes("OpenWork/mysql2 strict query succeeded after migration"), "OpenWork/mysql2 connects successfully after migration using strict TLS");
            ctx.output("MySQL TLS integration evidence", output);
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        const failures = [];
        await ctx.prove("Invalid custom CA states and environment conflicts fail during Helm rendering with clear errors", {
          voiceover: vo[4],
          action: async () => {
            const cases = [
              {
                name: "missing source",
                args: ["--set", "customCa.enabled=true"],
                message: "customCa.existingSecret or customCa.existingConfigMap is required when customCa.enabled=true",
              },
              {
                name: "multiple sources",
                args: ["--set", "customCa.enabled=true", "--set", "customCa.existingSecret=openwork-ca-secret", "--set", "customCa.existingConfigMap=openwork-ca-config"],
                message: "customCa.existingSecret and customCa.existingConfigMap are mutually exclusive when customCa.enabled=true",
              },
              {
                name: "empty key",
                args: ["--set", "customCa.enabled=true", "--set", "customCa.existingSecret=openwork-ca-secret", "--set-string", "customCa.key="],
                message: "customCa.key is required when customCa.enabled=true",
              },
              {
                name: "Den API env conflict",
                args: ["--set", "customCa.enabled=true", "--set", "customCa.existingSecret=openwork-ca-secret", "--set", "denApi.env.NODE_EXTRA_CA_CERTS=/tmp/ca.pem"],
                message: "denApi.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead",
              },
              {
                name: "Den Web env conflict",
                args: ["--set", "customCa.enabled=true", "--set", "customCa.existingSecret=openwork-ca-secret", "--set", "denWeb.env.NODE_EXTRA_CA_CERTS=/tmp/ca.pem"],
                message: "denWeb.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead",
              },
              {
                name: "inference env conflict",
                args: ["--set", "customCa.enabled=true", "--set", "customCa.existingSecret=openwork-ca-secret", "--set", "inference.env.NODE_EXTRA_CA_CERTS=/tmp/ca.pem"],
                message: "inference.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead",
              },
            ];

            for (const helmCase of cases) {
              const result = helmTemplate(helmCase.args);
              failures.push({ name: helmCase.name, status: result.status, stderr: result.stderr, message: helmCase.message });
            }
          },
          assert: async () => {
            for (const failure of failures) {
              witness(ctx, failure.status !== 0, `${failure.name} fails Helm rendering`, failure.stderr.trim());
              witness(ctx, failure.stderr.includes(failure.message), `${failure.name} reports a clear customCa error`, failure.stderr.trim());
            }
            ctx.output("Helm validation failures", failureSummary(failures));
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        let defaultRendered = "";
        let disabledRendered = "";
        await ctx.prove("Disabled custom CA support leaves the rendered chart byte-for-byte compatible with the default output", {
          voiceover: vo[5],
          action: async () => {
            const defaultResult = helmTemplate(["--set", "inference.enabled=true"]);
            witness(ctx, defaultResult.status === 0, "default helm template succeeds", defaultResult.stderr.trim());
            defaultRendered = defaultResult.stdout;

            const disabledResult = helmTemplate([
              "--set",
              "inference.enabled=true",
              "--set",
              "customCa.enabled=false",
              "--set",
              "customCa.existingSecret=ignored-ca-secret",
              "--set",
              "customCa.key=ignored.pem",
            ]);
            witness(ctx, disabledResult.status === 0, "helm template succeeds when customCa is explicitly disabled", disabledResult.stderr.trim());
            disabledRendered = disabledResult.stdout;
          },
          assert: async () => {
            witness(ctx, disabledRendered === defaultRendered, "Explicitly disabled customCa rendering is byte-for-byte identical to the default render");
            witness(ctx, !defaultRendered.includes("name: NODE_EXTRA_CA_CERTS"), "Default rendering does not add NODE_EXTRA_CA_CERTS");
            witness(ctx, !defaultRendered.includes(CUSTOM_CA_PATH), "Default rendering does not mount the custom CA file path");
            ctx.output("Compatibility evidence", "Default render and explicit customCa.enabled=false render are identical; no NODE_EXTRA_CA_CERTS or custom CA mount path appears.");
          },
        });
      },
    },
  ],
};

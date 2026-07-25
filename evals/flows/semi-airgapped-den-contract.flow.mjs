import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/semi-airgapped-den-contract.md).
// The runner fails this flow in demo mode if the narration drifts from that script.
const FLOW_ID = "semi-airgapped-den-contract";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_ROOT = join(ROOT, "apps", "app");
const DEN_API_ROOT = join(ROOT, "ee", "apps", "den-api");
const SERVER_ROOT = join(ROOT, "apps", "server");
const COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_DIAGNOSTICS_ORIGIN = "https://diagnostic.openworklabs.com";
const CUSTOMER_DIAGNOSTICS_ORIGIN = "https://diagnostic.customer.example";
const MIN_DIAGNOSTICS_BEARER_TOKEN_LENGTH = 24;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function commandOutput(command, args, cwd, result) {
  return [
    `$ ${command} ${args.join(" ")}`,
    `cwd: ${cwd}`,
    `exit: ${String(result.status)}`,
    "--- stdout ---",
    result.stdout.trim(),
    "--- stderr ---",
    result.stderr.trim(),
  ].join("\n").trim();
}

function combinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function passingTestCount(output) {
  const match = /\b(\d+)\s+pass\b/.exec(output);
  if (!match) return 0;
  const count = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(count) ? count : 0;
}

function outputContainsPassingTests(output) {
  return passingTestCount(output) > 0;
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

function denEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
    DB_MODE: "mysql",
    DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
    BETTER_AUTH_SECRET: "y".repeat(32),
    BETTER_AUTH_URL: "https://den.openwork.test",
    OPENWORK_DEV_MODE: "0",
    PROVISIONER_MODE: "stub",
    ...extra,
  };
}

function denEnvProbe(script, extra = {}) {
  return run("bun", ["--conditions", "development", "--eval", script], DEN_API_ROOT, denEnv(extra));
}

function parseJsonStdout(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

export default {
  id: FLOW_ID,
  title: "Semi air-gapped Den deployments keep their private-network contract",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let output = "";
        let result;
        await ctx.prove("The desktop derives Den API and MCP paths from one configured Den origin", {
          voiceover: vo[0],
          action: async () => {
            const args = [
              "test",
              "--isolate",
              "tests/den-mcp-url.test.ts",
              "-t",
              "ignores an explicit API origin when a base URL is present|getDenMcpUrl",
            ];
            result = run("bun", args, APP_ROOT);
            output = commandOutput("bun", args, APP_ROOT, result);
          },
          assert: async () => {
            const raw = combinedOutput(result);
            ctx.output("Den desktop URL tests", output);
            witness(ctx, result.status === 0, "resolveDenBaseUrls ignores an explicit API origin when baseUrl is present (focused bun tests exit 0)", output);
            witness(ctx, raw.includes(" 0 fail"), "den-mcp-url test output reports 0 failures", output);
            witness(ctx, outputContainsPassingTests(raw), "den-mcp-url test filter selected at least one passing test", output);
            witness(ctx, passingTestCount(raw) >= 2, "the focused filter covers both the explicit-API-origin and getDenMcpUrl contracts", output);
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        let output = "";
        let guardResult;
        let privateUrlProbe;
        let defaultEnvProbe;
        let allowEnvProbe;
        let devEnvProbe;
        await ctx.prove("Den blocks private MCP URLs by default and exposes only the documented opt-out switches", {
          voiceover: vo[1],
          action: async () => {
            const args = [
              "test",
              "test/mcp-url-guard.test.ts",
              "-t",
              "rejects private IP literals|allows private HTTP endpoints",
            ];
            guardResult = run("bun", args, DEN_API_ROOT, {
              ...process.env,
              DEN_ALLOW_PRIVATE_MCP_URLS: "",
              OPENWORK_DEV_MODE: "0",
            });
            output = commandOutput("bun", args, DEN_API_ROOT, guardResult);
            privateUrlProbe = denEnvProbe(`
              const { assertPublicUrl, PrivateUrlError } = await import("./src/capability-sources/url-guard.ts");
              let refused = false;
              let errorName = "";
              let message = "";
              try {
                await assertPublicUrl("http://10.0.0.5/mcp");
              } catch (error) {
                refused = error instanceof PrivateUrlError;
                errorName = error instanceof Error ? error.name : String(error);
                message = error instanceof Error ? error.message : String(error);
              }
              console.log(JSON.stringify({ refused, errorName, message }));
            `);
            defaultEnvProbe = denEnvProbe(`
              const { env } = await import("./src/env.ts");
              console.log(JSON.stringify({ allowPrivateMcpUrls: env.allowPrivateMcpUrls }));
            `);
            allowEnvProbe = denEnvProbe(`
              const { env } = await import("./src/env.ts");
              console.log(JSON.stringify({ allowPrivateMcpUrls: env.allowPrivateMcpUrls }));
            `, { DEN_ALLOW_PRIVATE_MCP_URLS: "1" });
            devEnvProbe = denEnvProbe(`
              const { env } = await import("./src/env.ts");
              console.log(JSON.stringify({ allowPrivateMcpUrls: env.allowPrivateMcpUrls }));
            `, { OPENWORK_DEV_MODE: "1" });
          },
          assert: async () => {
            const raw = combinedOutput(guardResult);
            const privateUrl = parseJsonStdout(privateUrlProbe);
            const defaultEnv = parseJsonStdout(defaultEnvProbe);
            const allowEnv = parseJsonStdout(allowEnvProbe);
            const devEnv = parseJsonStdout(devEnvProbe);
            ctx.output("MCP URL guard tests", output);
            ctx.output("Private URL default-deny probe", commandOutput("bun", ["--conditions", "development", "--eval", "<private URL probe>"], DEN_API_ROOT, privateUrlProbe));
            ctx.output("DEN_ALLOW_PRIVATE_MCP_URLS env probes", [
              commandOutput("bun", ["--conditions", "development", "--eval", "<default env probe>"], DEN_API_ROOT, defaultEnvProbe),
              commandOutput("bun", ["--conditions", "development", "--eval", "<DEN_ALLOW_PRIVATE_MCP_URLS=1 env probe>"], DEN_API_ROOT, allowEnvProbe),
              commandOutput("bun", ["--conditions", "development", "--eval", "<OPENWORK_DEV_MODE=1 env probe>"], DEN_API_ROOT, devEnvProbe),
            ].join("\n\n"));
            witness(ctx, guardResult.status === 0, "mcp-url-guard focused tests exit 0", output);
            witness(ctx, raw.includes(" 0 fail"), "mcp-url-guard test output reports 0 failures", output);
            witness(ctx, outputContainsPassingTests(raw), "mcp-url-guard test filter selected at least one passing test", output);
            witness(ctx, passingTestCount(raw) >= 2, "the guard filter covers default private-IP rejection and private-mode fetch behavior", output);
            witness(ctx, privateUrlProbe.status === 0, "the direct private URL refusal probe exits 0", commandOutput("bun", ["--conditions", "development", "--eval", "<private URL probe>"], DEN_API_ROOT, privateUrlProbe));
            witness(ctx, privateUrl?.refused === true, "with the variables unset, a private MCP URL is refused", JSON.stringify(privateUrl));
            witness(ctx, privateUrl?.errorName === "PrivateUrlError", "the default-deny refusal is a PrivateUrlError", JSON.stringify(privateUrl));
            witness(ctx, defaultEnvProbe.status === 0 && defaultEnv?.allowPrivateMcpUrls === false, "env.allowPrivateMcpUrls is false by default", commandOutput("bun", ["--conditions", "development", "--eval", "<default env probe>"], DEN_API_ROOT, defaultEnvProbe));
            witness(ctx, allowEnvProbe.status === 0 && allowEnv?.allowPrivateMcpUrls === true, "DEN_ALLOW_PRIVATE_MCP_URLS=1 is an opt-out switch", commandOutput("bun", ["--conditions", "development", "--eval", "<DEN_ALLOW_PRIVATE_MCP_URLS=1 env probe>"], DEN_API_ROOT, allowEnvProbe));
            witness(ctx, devEnvProbe.status === 0 && devEnv?.allowPrivateMcpUrls === true, "OPENWORK_DEV_MODE=1 is the local-dev opt-out switch", commandOutput("bun", ["--conditions", "development", "--eval", "<OPENWORK_DEV_MODE=1 env probe>"], DEN_API_ROOT, devEnvProbe));
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        let output = "";
        let result;
        let untrustedProbe;
        await ctx.prove("Cloud MCP diagnostics skip untrusted Den origins before any credentialed request", {
          voiceover: vo[2],
          action: async () => {
            const args = [
              "test",
              "src/agent-context-cloud-probe.test.ts",
              "-t",
              "blocks remote workspaces|allows exact loopback",
            ];
            result = run("bun", args, SERVER_ROOT, {
              ...process.env,
              OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS: "",
            });
            output = commandOutput("bun", args, SERVER_ROOT, result);
            untrustedProbe = run("bun", ["--eval", `
              const { probeOpenworkCloudCatalog } = await import("./src/agent-context-cloud-probe.ts");
              let calls = 0;
              const observed = await probeOpenworkCloudCatalog({
                workspaceId: "ws_private_den",
                workspaceType: "local",
                config: {
                  type: "remote",
                  enabled: true,
                  url: "https://den.customer.example/mcp/agent",
                  headers: { authorization: "Bearer ow_diagnostics_token_abcdefghijklmnopqrstuvwxyz" },
                },
                toolPolicyStatus: "available",
                toolPolicyProvenance: "authoritative-effective-engine",
                registrationStatus: "connected",
                requestId: "22222222-2222-4222-8222-222222222222",
                fetchImpl: async () => {
                  calls += 1;
                  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
                },
              });
              console.log(JSON.stringify({ calls, observed }));
            `], SERVER_ROOT, {
              ...process.env,
              OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS: "",
            });
          },
          assert: async () => {
            const raw = combinedOutput(result);
            const untrusted = parseJsonStdout(untrustedProbe);
            ctx.output("Cloud MCP diagnostic tests", output);
            ctx.output("Untrusted diagnostic-origin probe", commandOutput("bun", ["--eval", "<untrusted endpoint probe>"], SERVER_ROOT, untrustedProbe));
            witness(ctx, result.status === 0, "agent-context-cloud-probe focused tests exit 0", output);
            witness(ctx, raw.includes(" 0 fail"), "agent-context-cloud-probe test output reports 0 failures", output);
            witness(ctx, outputContainsPassingTests(raw), "agent-context-cloud-probe test filter selected at least one passing test", output);
            witness(ctx, passingTestCount(raw) >= 2, "the diagnostic filter covers untrusted blocking and explicit trusted-origin allowance", output);
            witness(ctx, untrustedProbe.status === 0, "the direct untrusted-origin probe exits 0", commandOutput("bun", ["--eval", "<untrusted endpoint probe>"], SERVER_ROOT, untrustedProbe));
            witness(ctx, untrusted?.observed?.code === "untrusted_endpoint", "an untrusted self-hosted Den origin yields untrusted_endpoint", JSON.stringify(untrusted));
            witness(ctx, untrusted?.observed?.performed === false, "the untrusted diagnostic is skipped before the probe is performed", JSON.stringify(untrusted));
            witness(ctx, untrusted?.observed?.status === "not-performed", "the skipped diagnostic is not reported as a failed network check", JSON.stringify(untrusted));
            witness(ctx, untrusted?.observed?.toolsListPerformed === false, "the untrusted diagnostic never starts tools/list", JSON.stringify(untrusted));
            witness(ctx, untrusted?.calls === 0, "no fetch request is made, so no organization MCP token is sent", JSON.stringify(untrusted));
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        let output = "";
        let result;
        let defaultProbe;
        let overrideProbe;
        let shortTokenProbe;
        let validTokenProbe;
        await ctx.prove("Den diagnostics use an operator-configurable origin and require a 24-character bearer token", {
          voiceover: vo[3],
          action: async () => {
            const args = [
              "test",
              "test/egress-diagnostics.test.ts",
              "-t",
              "defaults to the OpenWork Labs diagnostic host and accepts an operator override",
            ];
            result = run("bun", args, DEN_API_ROOT);
            output = commandOutput("bun", args, DEN_API_ROOT, result);
            defaultProbe = denEnvProbe(`
              const { DEFAULT_DEN_DIAGNOSTICS_ORIGIN, env } = await import("./src/env.ts");
              console.log(JSON.stringify({ defaultOrigin: DEFAULT_DEN_DIAGNOSTICS_ORIGIN, configuredOrigin: env.diagnostics.origin }));
            `);
            overrideProbe = denEnvProbe(`
              const { env } = await import("./src/env.ts");
              console.log(JSON.stringify({ configuredOrigin: env.diagnostics.origin }));
            `, { DEN_DIAGNOSTICS_ORIGIN: `${CUSTOMER_DIAGNOSTICS_ORIGIN}/` });
            shortTokenProbe = denEnvProbe("await import(\"./src/env.ts\")", {
              DEN_DIAGNOSTICS_BEARER_TOKEN: "x".repeat(MIN_DIAGNOSTICS_BEARER_TOKEN_LENGTH - 1),
            });
            validTokenProbe = denEnvProbe(`
              const { env } = await import("./src/env.ts");
              console.log(JSON.stringify({ tokenLength: env.diagnostics.bearerToken?.length ?? null }));
            `, { DEN_DIAGNOSTICS_BEARER_TOKEN: "x".repeat(MIN_DIAGNOSTICS_BEARER_TOKEN_LENGTH) });
          },
          assert: async () => {
            const raw = combinedOutput(result);
            const defaultJson = parseJsonStdout(defaultProbe);
            const overrideJson = parseJsonStdout(overrideProbe);
            const validTokenJson = parseJsonStdout(validTokenProbe);
            const shortTokenOutput = commandOutput("bun", ["--conditions", "development", "--eval", "<short bearer token probe>"], DEN_API_ROOT, shortTokenProbe);
            ctx.output("Den egress diagnostics env tests", output);
            ctx.output("Diagnostics origin env probes", [
              commandOutput("bun", ["--conditions", "development", "--eval", "<default diagnostics origin probe>"], DEN_API_ROOT, defaultProbe),
              commandOutput("bun", ["--conditions", "development", "--eval", "<override diagnostics origin probe>"], DEN_API_ROOT, overrideProbe),
            ].join("\n\n"));
            ctx.output("Diagnostics bearer token probes", [
              shortTokenOutput,
              commandOutput("bun", ["--conditions", "development", "--eval", "<valid bearer token probe>"], DEN_API_ROOT, validTokenProbe),
            ].join("\n\n"));
            witness(ctx, result.status === 0, "egress-diagnostics focused env test exits 0", output);
            witness(ctx, raw.includes(" 0 fail"), "egress-diagnostics test output reports 0 failures", output);
            witness(ctx, outputContainsPassingTests(raw), "egress-diagnostics test filter selected at least one passing test", output);
            witness(ctx, defaultProbe.status === 0 && defaultJson?.defaultOrigin === DEFAULT_DIAGNOSTICS_ORIGIN, "the source exports the public diagnostics default origin", commandOutput("bun", ["--conditions", "development", "--eval", "<default diagnostics origin probe>"], DEN_API_ROOT, defaultProbe));
            witness(ctx, defaultJson?.configuredOrigin === DEFAULT_DIAGNOSTICS_ORIGIN, "without DEN_DIAGNOSTICS_ORIGIN, env.diagnostics.origin uses the public default", JSON.stringify(defaultJson));
            witness(ctx, overrideProbe.status === 0 && overrideJson?.configuredOrigin === CUSTOMER_DIAGNOSTICS_ORIGIN, "DEN_DIAGNOSTICS_ORIGIN selects the operator-provided diagnostics origin", commandOutput("bun", ["--conditions", "development", "--eval", "<override diagnostics origin probe>"], DEN_API_ROOT, overrideProbe));
            witness(ctx, shortTokenProbe.status !== 0, "a 23-character DEN_DIAGNOSTICS_BEARER_TOKEN is rejected", shortTokenOutput);
            witness(ctx, combinedOutput(shortTokenProbe).includes("at least 24 characters"), "the bearer-token validation reports the real 24-character minimum", shortTokenOutput);
            witness(ctx, validTokenProbe.status === 0 && validTokenJson?.tokenLength === MIN_DIAGNOSTICS_BEARER_TOKEN_LENGTH, "a 24-character DEN_DIAGNOSTICS_BEARER_TOKEN is accepted", commandOutput("bun", ["--conditions", "development", "--eval", "<valid bearer token probe>"], DEN_API_ROOT, validTokenProbe));
          },
        });
      },
    },
  ],
};

import { createHash } from "node:crypto";
import type { Place, Seed } from "@openwork/env";
import {
  deploymentStepSchema, managedDeploymentLaunchSchema, managedDeploymentListSchema, managedDeploymentSchema,
  type DeploymentEventInput, type HealthCheck, type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { z } from "zod";

/**
 * A workspace whose owner has one AWS deployment that is already installed,
 * with configuration changes still turned off.
 *
 * Nothing here is in AWS. The world plays the customer's AWS account the way
 * the installer and health agent do, over HTTP against the Den API: it reads
 * the run and challenge from the approval Den hands out, enrolls, and reports
 * the six milestones. Den's one call to AWS on those paths, the replay of a
 * signed request to regional STS, is answered inside the Den API process by
 * `managed-deployment-aws-identity-preload.mjs`, which refuses every other
 * request to an amazonaws.com host.
 */

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const VERSION = "1.4.0";
const FIXTURE_LOG = "Managed deployment AWS identity fixture:";
const SOURCE = `https://installer-fixture.s3.${REGION}.amazonaws.com/releases/aws/${VERSION}/`;
const RELEASE = {
  version: VERSION, bundleSha256: "c".repeat(64),
  templateUrl: `${SOURCE}cloudformation.json?versionId=fixture-template-${VERSION}`,
  bundleUrl: `${SOURCE}bundle.tar.gz?versionId=fixture-bundle-${VERSION}`,
};
const STEPS = deploymentStepSchema.options;
type FailureCode = NonNullable<DeploymentEventInput["errorCode"]>;

const fixtureLineSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("loaded"), pid: z.number(), entry: z.string().nullable() }),
  z.object({ event: z.literal("answered"), region: z.string(), account: z.string(), role: z.string() }),
  z.object({ event: z.literal("denied"), region: z.string() }),
  z.object({ event: z.literal("refused"), host: z.string(), via: z.string() }),
]);
const parametersSchema = z.array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() }));
const organizationSchema = z.object({ organization: z.object({ id: z.string() }), currentMember: z.object({ id: z.string() }) });
const enrollmentSchema = z.object({ token: z.string() });

/** What an approval asks AWS to run: the installer template and its parameters. */
export type AwsApproval = { templateUrl: string; parameters: Record<string, string>; deploymentId: string; runId: string; version: string };
/** An installer run that has enrolled with Den and reports its milestones in order. */
type InstallerRun = { approval: AwsApproval; token: string; reported: number };

function compact(deploymentId: string) {
  return deploymentId.replaceAll("-", "");
}

function parameter(parameters: Record<string, string>, key: string) {
  const value = parameters[key];
  if (!value) throw new Error(`The approval has no ${key} parameter`);
  return value;
}

/** Reads an approval as the customer's AWS account receives it: a CloudFormation quick-create link, or the CloudShell command. */
export function readAwsApproval(commandOrLink: string): AwsApproval {
  let templateUrl: string;
  let parameters: Record<string, string>;
  if (/^https:\/\/\S+$/.test(commandOrLink.trim()) && URL.canParse(commandOrLink.trim())) {
    const query = new URLSearchParams(new URL(commandOrLink.trim()).hash.split("?")[1] ?? "");
    templateUrl = query.get("templateURL") ?? "";
    parameters = Object.fromEntries([...query].filter(([key]) => key.startsWith("param_")).map(([key, value]) => [key.slice(6), value]));
  } else {
    // Wherever they sit in the command: the stack update's template and its parameter list, each one shell-quoted argument.
    const quoted = (flag: string) => new RegExp(`${flag}\\s+'((?:[^']|'\\\\'')*)'`).exec(commandOrLink)?.[1]?.replaceAll("'\\''", "'");
    const list = quoted("--parameters");
    if (!list) throw new Error("The text is neither an AWS approval link nor a CloudShell command that updates the installer");
    templateUrl = quoted("--template-url") ?? "";
    parameters = Object.fromEntries(parametersSchema.parse(JSON.parse(list)).map((entry) => [entry.ParameterKey, entry.ParameterValue]));
  }
  if (!templateUrl) throw new Error("The approval names no installer template");
  return { templateUrl, parameters, deploymentId: parameter(parameters, "DeploymentId"), runId: parameter(parameters, "RunId"), version: parameter(parameters, "OpenWorkVersion") };
}

export async function managedDeploymentConfigurationWorld(seed: Seed, { place }: { place: Place }) {
  const fixture = place.kind === "daytona"
    ? "file:///workspace/evals/packages/labs/src/managed-deployment-aws-identity-preload.mjs"
    : new URL("../packages/labs/src/managed-deployment-aws-identity-preload.mjs", import.meta.url).href;
  const den = await seed.den({ web: true, env: {
    DEN_DEPLOYMENT: "cloud", DB_MODE: "mysql", DATABASE_REDIS_URL: "",
    // Imported unconditionally: without the fixture file the Den API does not start.
    NODE_OPTIONS: `--import=${fixture}`,
    DEN_MANAGED_DEPLOYMENT_AWS_RELEASE: JSON.stringify(RELEASE),
    RESEND_API_KEY: "", LOOPS_API_KEY: "", SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "",
    OTEL_SDK_DISABLED: "true", NEXT_TELEMETRY_DISABLED: "1",
  }, org: {
    name: "Example workspace",
    admin: { name: "Workspace owner", email: "owner@example.com" },
    members: { teammate: { name: "Workspace admin", email: "teammate@example.com" } },
  } });
  const owner = den.admin;
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("The workspace admin was not provisioned");
  const apiOrigin = new URL(den.ref.apiUrl).origin;
  if (!["127.0.0.1", "localhost"].includes(new URL(apiOrigin).hostname) && place.kind !== "daytona") throw new Error("This world drives only a Den API on this machine");

  const organizationId = organizationSchema.parse((await seed.api(owner, "/v1/org")).body).organization.id;
  const setFeatures = async (capabilities: Record<string, boolean>) => {
    const result = await seed.api(owner, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities }) });
    if (!result.response.ok) throw new Error(`Setting ${Object.keys(capabilities).join(", ")} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  };
  await setFeatures({ managedDeployments: true, managedDeploymentAssistants: true, managedDeploymentConfigUpdates: false });
  // A workspace admin can see deployments; only the owner can manage them.
  const teammateId = organizationSchema.parse((await seed.api(teammate, "/v1/org")).body).currentMember.id;
  const promoted = await seed.api(owner, `/v1/members/${encodeURIComponent(teammateId)}/role`, { method: "POST", body: JSON.stringify({ role: "admin" }) });
  if (!promoted.response.ok) throw new Error(`Making the teammate a workspace admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);

  // ---- The customer's AWS account, played over HTTP ----

  async function fixtureLines() {
    const log = await den.apiLog();
    return log.split("\n").flatMap((line) => {
      const at = line.indexOf(FIXTURE_LOG);
      if (at < 0) return [];
      try {
        const parsed = fixtureLineSchema.safeParse(JSON.parse(line.slice(at + FIXTURE_LOG.length)));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /** Refuses to send anything that would make Den call AWS unless the served API process itself runs the fixture. */
  async function requireFixture() {
    const loaded = (await fixtureLines()).some((line) => line.event === "loaded" && /[\\/]src[\\/]main\.ts$/.test(line.entry ?? ""));
    if (!loaded) throw new Error("The Den API is not running the AWS identity fixture, so the world will not send it a signed AWS identity");
  }

  /** Den posts back only to the control plane the approval names; here that must be this world's Den API. */
  function controlPlane(approval: AwsApproval) {
    const origin = parameter(approval.parameters, "ControlPlaneOrigin");
    if (origin !== apiOrigin) throw new Error(`The approval reports to ${origin}, not to this world's Den API`);
    if (parameter(approval.parameters, "ExpectedAccountId") !== ACCOUNT) throw new Error("The approval is for another AWS account");
    return origin;
  }

  /** The headers of an unsent, signed STS GetCallerIdentity request, as a role in the customer's account produces them. */
  function signedIdentity(role: string, proof: string) {
    const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const signature = createHash("sha256").update(`${role}:${proof}`).digest("hex");
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=FIXTURE/${date.slice(0, 8)}/${REGION}/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof, Signature=${signature}`,
      "x-amz-date": date, "x-amz-security-token": `fixture-role/${role}`, "x-openwork-proof": proof,
    };
  }

  async function post(origin: string, path: string, init: { headers?: Record<string, string>; body: string }) {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body: init.body, signal: AbortSignal.timeout(30_000) });
    return { status: response.status, text: await response.text() };
  }

  /** The installer starts in the customer's account: it proves which role it runs as and receives its run token. */
  async function enroll(approval: AwsApproval, role = `openwork-${compact(approval.deploymentId)}-runner`) {
    await requireFixture();
    const origin = controlPlane(approval);
    const proof = `enroll:${approval.runId}:${parameter(approval.parameters, "Challenge")}`;
    return post(origin, `/v1/managed-deployments/${approval.deploymentId}/runs/${approval.runId}/enroll`, { body: JSON.stringify({ headers: signedIdentity(role, proof) }) });
  }

  async function report(run: InstallerRun, event: DeploymentEventInput) {
    const result = await post(controlPlane(run.approval), `/v1/managed-deployments/${run.approval.deploymentId}/runs/${run.approval.runId}/events`, {
      headers: { authorization: `Bearer ${run.token}` }, body: JSON.stringify(event),
    });
    if (result.status !== 200) throw new Error(`Den refused milestone ${event.sequence} (${event.step}): HTTP ${result.status} ${result.text.slice(0, 300)}`);
    run.reported = event.sequence;
  }

  const aws = {
    /** The customer runs the approval in their account: the installer enrolls. No milestone is reported yet. */
    async start(commandOrLink: string): Promise<InstallerRun> {
      const approval = readAwsApproval(commandOrLink);
      // Configuration commands reserve the current approval before CloudFormation
      // is allowed to change the installer. Play that step over local HTTP too.
      if (commandOrLink.includes("/approval-check")) {
        const checked = await post(controlPlane(approval), `/v1/managed-deployments/${approval.deploymentId}/runs/${approval.runId}/approval-check`, {
          body: JSON.stringify({ challenge: parameter(approval.parameters, "Challenge") }),
        });
        if (checked.status !== 200) throw new Error(`Den refused the approval check: HTTP ${checked.status} ${checked.text.slice(0, 300)}`);
      }
      const enrolled = await enroll(approval);
      if (enrolled.status !== 200) throw new Error(`Den refused the installer's enrollment: HTTP ${enrolled.status} ${enrolled.text.slice(0, 300)}`);
      return { approval, token: enrollmentSchema.parse(JSON.parse(enrolled.text)).token, reported: 0 };
    },
    /** The installer reports its next milestones in order, up to and including `through` (1 to 6). */
    async progress(run: InstallerRun, through: number) {
      for (let sequence = run.reported + 1; sequence <= through; sequence += 1) {
        const step = STEPS[sequence - 1];
        if (!step) throw new Error(`The installer has no milestone ${sequence}`);
        await report(run, { sequence, step, outcome: "succeeded" });
      }
    },
    /** The installer's next milestone fails. */
    async fail(run: InstallerRun, errorCode: FailureCode) {
      const step = STEPS[run.reported];
      if (!step) throw new Error("The installer has already reported every milestone");
      await report(run, { sequence: run.reported + 1, step, outcome: "failed", errorCode });
    },
    /** The whole approval: enroll, then all six milestones. */
    async approve(commandOrLink: string) {
      const run = await aws.start(commandOrLink);
      await aws.progress(run, STEPS.length);
      return run.approval;
    },
    /** What Den answers when the installer for this approval tries to enroll, as the installer's role or another. */
    async enrollStatus(commandOrLink: string, role?: string) {
      return (await enroll(readAwsApproval(commandOrLink), role)).status;
    },
    /** The read-only health agent in the customer's account reports its checks. */
    async reportHealth(deploymentId: string, options: { gateway: boolean }) {
      await requireFixture();
      const checks: HealthCheck[] = [
        { id: "api_health", status: "ok", value: 42 }, { id: "database_ready", status: "ok" }, { id: "web_available", status: "ok", value: 61 },
        { id: "services_running", status: "ok", value: options.gateway ? 5 : 2, total: options.gateway ? 5 : 2 },
        { id: "load_balancer_targets", status: "ok", value: 2, total: 2 }, { id: "database_instance", status: "ok" },
        { id: "database_storage", status: "ok", value: 17.5, total: 20 }, { id: "database_backups", status: "ok", value: 0.4 },
        { id: "certificate", status: "ok", value: 300 },
        ...(options.gateway ? [
          { id: "ai_gateway_available", status: "ok", value: 38 }, { id: "runner_service", status: "ok" }, { id: "workbot_available", status: "ok" },
          { id: "runner_storage", status: "ok", value: 0.2 }, { id: "runner_backups", status: "ok", value: 0.3 },
        ] satisfies HealthCheck[] : []),
      ];
      const body = JSON.stringify({ version: VERSION, checks });
      const identity = signedIdentity(`openwork-${compact(deploymentId)}-health`, `heartbeat:${deploymentId}:${createHash("sha256").update(body).digest("hex")}`);
      const result = await post(apiOrigin, `/v1/managed-deployments/${deploymentId}/heartbeat`, { body, headers: {
        "x-openwork-aws-authorization": identity.authorization, "x-openwork-aws-date": identity["x-amz-date"],
        "x-openwork-aws-security-token": identity["x-amz-security-token"], "x-openwork-proof": identity["x-openwork-proof"],
      } });
      if (result.status !== 200) throw new Error(`Den refused the health report: HTTP ${result.status} ${result.text.slice(0, 300)}`);
    },
  };

  // ---- The installed deployment: created, approved and installed the way a customer does it ----

  const input = {
    provider: "aws", name: "Production", domainName: "openwork.example.com", ownerEmail: "admin@example.com",
    target: { accountId: ACCOUNT, region: REGION, route53ZoneId: "Z0123456789ABC", runtimeProfile: "legacy" },
  };
  const created = await seed.api(owner, "/v1/managed-deployments", { method: "POST", body: JSON.stringify(input) });
  if (!created.response.ok) throw new Error(`Creating the deployment failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  const deploymentId = managedDeploymentSchema.parse(created.body).id;
  const launched = await seed.api(owner, `/v1/managed-deployments/${deploymentId}/launch`, { method: "POST", body: JSON.stringify({ kind: "install" }) });
  if (!launched.response.ok) throw new Error(`Preparing the installation failed: HTTP ${launched.response.status} ${launched.text.slice(0, 300)}`);
  const approvalUrl = managedDeploymentLaunchSchema.parse(launched.body).approvalUrl;
  if (!approvalUrl) throw new Error("The installation has no AWS approval link");
  const installation = await aws.approve(approvalUrl);
  await aws.reportHealth(deploymentId, { gateway: false });

  const viewport = { width: 1280, height: 1200 };
  const ownerWeb = await seed.web({ den, signedInAs: owner, startPath: "/dashboard/deployments", headless: true, viewport });
  const teammateWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard/deployments", headless: true, viewport });

  async function deployment(session = owner): Promise<ManagedDeployment> {
    const result = await seed.api(session, "/v1/managed-deployments");
    if (!result.response.ok) throw new Error(`Reading deployments failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    const found = managedDeploymentListSchema.parse(result.body).deployments.find((entry) => entry.id === deploymentId);
    if (!found) throw new Error("The deployment is no longer listed");
    return found;
  }

  return {
    den, owner: ownerWeb, teammate: teammateWeb, aws,
    account: ACCOUNT, deploymentId, installedVersion: installation.version,
    /** The deployment as Den's API lists it for the owner (a read). */
    deployment: () => deployment(),
    /** An operator turns configuration changes on or off for this workspace, as /admin does. */
    async setConfigurationChanges(enabled: boolean) {
      await setFeatures({ managedDeploymentConfigUpdates: enabled });
    },
    /** Exercise the deployment detail route when guided AWS sign-in is also enabled. */
    async setGuidedApproval(enabled: boolean) {
      await setFeatures({ managedDeploymentAwsSignIn: enabled });
    },
    /**
     * The owner or the workspace admin asks Den's API directly for a change, with a request that is otherwise
     * valid: the deployment as their own view shows it, with the given edits. Returns how Den answered.
     */
    async requestChange(who: "owner" | "teammate", edit: { ownerEmail?: string; name?: string }) {
      const session = who === "owner" ? owner : teammate;
      const shown = await deployment(session);
      if (shown.provider !== "aws") throw new Error("The deployment is not on AWS");
      const result = await seed.api(session, `/v1/managed-deployments/${deploymentId}/configuration-changes`, { method: "POST", body: JSON.stringify({
        expectedRevision: shown.configuration?.revision ?? "0".repeat(64),
        configuration: { provider: "aws", name: edit.name ?? shown.name, domainName: shown.domainName, ownerEmail: edit.ownerEmail ?? shown.ownerEmail, size: shown.size, target: shown.target },
      }) });
      const answer = z.object({ error: z.string().optional(), message: z.string().optional(), outcome: z.string().optional() }).catch({}).parse(result.body);
      const launch = managedDeploymentLaunchSchema.safeParse(result.body);
      return { status: result.response.status, error: answer.error ?? null, message: answer.message ?? null, outcome: answer.outcome ?? null, command: launch.success ? launch.data.command : null };
    },
    /** Everything Den's API process tried to send to AWS, as the fixture saw it. */
    async awsTraffic() {
      const lines = await fixtureLines();
      return {
        answered: lines.flatMap((line) => line.event === "answered" ? [line] : []),
        denied: lines.filter((line) => line.event === "denied").length,
        refused: lines.flatMap((line) => line.event === "refused" ? [line] : []),
      };
    },
  };
}

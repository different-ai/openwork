import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";

// The documented pull-only evaluation stack (packaging/docker/docker-compose.eval.yml)
// exactly as packages/docs/self-host/evaluate-with-docker-compose.mdx ships it:
// the published, digest-pinned images, no override, booted as an isolated
// Compose project in the documented "private first administrator" shape
// (OPENWORK_ALLOW_SIGNUP=false + OPENWORK_OWNER_EMAILS + OPENWORK_SETUP_CODE).
//
// Unlike den-compose-eval.ts this world never swaps an image, so it observes
// what a customer following the docs gets today, including defects that a
// merged source fix has not yet shipped in a published image.

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPOSE_FILE = join(REPO_ROOT, "packaging", "docker", "docker-compose.eval.yml");
const DOCS_FILE = join(REPO_ROOT, "packages", "docs", "self-host", "evaluate-with-docker-compose.mdx");
const INTERNAL_API_ORIGIN = "http://den:8788";
const HEALTHY_WITHIN_MS = 240_000;

export interface DocumentedComposeDownload {
  /** Commit the docs tell the customer to download docker-compose.eval.yml from. */
  commit: string;
  /** SHA-256 the docs tell the customer to verify against. */
  sha256: string;
}

export interface PublishedComposeImage {
  service: "den" | "web";
  /** Image reference as pinned in the compose file (tag@digest). */
  reference: string;
  /** OCI revision label of the running container, or "" when the image carries none. */
  revision: string;
  /** OCI version label of the running container, or "" when the image carries none. */
  version: string;
}

export interface DenComposePublishedWorld extends AsyncDisposable {
  /** Compose project name; every container, network and volume carries it. */
  project: string;
  /** Host URL of the documented `web` service. */
  webUrl: string;
  /** Browser-reachable Den API origin, exactly as DEN_API_PUBLIC_URL is configured. */
  publicApiOrigin: string;
  /** Container-internal Den API origin that must never reach a browser. */
  internalApiOrigin: string;
  /** Owner email allowed to claim the organization at /setup. */
  ownerEmail: string;
  /** One-time setup code handed to Den API; process-only, never written to disk. */
  setupCode: string;
  /** Download instructions the docs currently publish. */
  documented: DocumentedComposeDownload;
  /** SHA-256 of the compose definition this world actually booted. */
  composeSha256: string;
  /** Published images the stack pulled, with their OCI labels. */
  images: PublishedComposeImage[];
  logs(service: "web" | "den"): Promise<string>;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function compose(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  return stdout;
}

async function waitForHealthy(url: string, label: string, logs: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${last}. Last log lines:\n${(await logs()).split(/\r?\n/).slice(-40).join("\n")}`);
}

async function documentedDownload(): Promise<DocumentedComposeDownload> {
  const docs = await readFile(DOCS_FILE, "utf8");
  const commit = /raw\.githubusercontent\.com\/different-ai\/openwork\/([0-9a-f]{40})\/packaging\/docker\/docker-compose\.eval\.yml/.exec(docs)?.[1];
  const sha256 = /'([0-9a-f]{64})'\s*\\?\s*'docker-compose\.eval\.yml'/.exec(docs)?.[1];
  if (!commit || !sha256) {
    throw new Error(`Could not read the documented compose download (commit URL and checksum) from ${DOCS_FILE}.`);
  }
  return { commit, sha256 };
}

function pinnedImage(composeSource: string, service: "den" | "web"): string {
  const block = new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    image: (\\S+)`, "m").exec(composeSource);
  if (!block?.[1]) throw new Error(`Could not read the pinned image for service ${service} from ${COMPOSE_FILE}.`);
  return block[1];
}

async function containerLabels(container: string): Promise<{ revision: string; version: string }> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    container,
    "--format",
    '{{index .Config.Labels "org.opencontainers.image.revision"}}\t{{index .Config.Labels "org.opencontainers.image.version"}}',
  ]);
  const [revision = "", version = ""] = stdout.trim().split("\t");
  return { revision, version };
}

export async function denComposePublished(): Promise<DenComposePublishedWorld> {
  const composeSource = await readFile(COMPOSE_FILE, "utf8");
  const composeSha256 = createHash("sha256").update(composeSource).digest("hex");
  const documented = await documentedDownload();

  const [webPort, apiPort] = await allocateFreePorts(2);
  if (webPort === undefined || apiPort === undefined) {
    throw new Error("Could not allocate host ports for the published compose evaluation stack.");
  }
  const project = `openwork-eval-published-${randomBytes(4).toString("hex")}`;
  const publicApiOrigin = `http://localhost:${apiPort}`;
  const ownerEmail = "admin@example.com";
  const setupCode = randomBytes(16).toString("hex");

  // Every value here is one the docs name; they reach Compose through the
  // process environment (the documented alternative to the .env file).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENWORK_WEB_PORT: String(webPort),
    OPENWORK_API_PORT: String(apiPort),
    OPENWORK_AUTH_SECRET: randomBytes(32).toString("hex"),
    OPENWORK_DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    OPENWORK_ALLOW_SIGNUP: "false",
    OPENWORK_OWNER_EMAILS: ownerEmail,
    OPENWORK_SETUP_CODE: setupCode,
  };
  const composeArgs = ["-p", project, "-f", COMPOSE_FILE];
  const logs = async (service: "web" | "den") =>
    compose([...composeArgs, "logs", "--no-color", "--tail", "80", service], env).catch((error: unknown) => `logs unavailable: ${messageText(error)}`);

  const down = async () => {
    await compose([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], env)
      .catch((error: unknown) => console.error(`[openwork/testkit] compose down failed for ${project}: ${messageText(error)}`));
  };

  const webUrl = `http://127.0.0.1:${webPort}`;
  let images: PublishedComposeImage[];
  try {
    await compose([...composeArgs, "up", "-d", "--wait", "--wait-timeout", "240"], env);
    await waitForHealthy(`${publicApiOrigin}/health`, "den", () => logs("den"));
    await waitForHealthy(`${webUrl}/api/health`, "web", () => logs("web"));
    images = await Promise.all((["den", "web"] as const).map(async (service) => ({
      service,
      reference: pinnedImage(composeSource, service),
      ...(await containerLabels(`${project}-${service}-1`)),
    })));
  } catch (error) {
    await down();
    throw error;
  }

  return {
    project,
    webUrl,
    publicApiOrigin,
    internalApiOrigin: INTERNAL_API_ORIGIN,
    ownerEmail,
    setupCode,
    documented,
    composeSha256,
    images,
    logs,
    [Symbol.asyncDispose]: down,
  };
}

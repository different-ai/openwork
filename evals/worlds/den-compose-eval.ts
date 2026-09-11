import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";
import { SkipError, type Seed } from "@openwork/env";

// The documented pull-only evaluation stack (packaging/docker/docker-compose.eval.yml)
// booted as an isolated Compose project, with the `web` service swapped for a
// locally built den-web image so a den-web source change can be proven across
// the real container boundary before an image release ships it.
//
// Two web containers share one Den API and database:
//   web          the documented shape: DEN_API_BASE=http://den:8788 (in-network
//                proxy upstream) plus the browser-reachable DEN_API_PUBLIC_URL.
//   web-fallback identical, but without DEN_API_PUBLIC_URL, to observe the
//                documented DEN_API_BASE fallback.

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPOSE_FILE = join(REPO_ROOT, "packaging", "docker", "docker-compose.eval.yml");
const INTERNAL_API_ORIGIN = "http://den:8788";
const HEALTHY_WITHIN_MS = 240_000;

export interface DenComposeEvalWorld extends AsyncDisposable {
  /** Compose project name; every container, network and volume carries it. */
  project: string;
  /** den-web image under test (OPENWORK_EVAL_DEN_WEB_IMAGE). */
  image: string;
  /** Host URL of the documented `web` service (DEN_API_PUBLIC_URL set). */
  webUrl: string;
  /** Host URL of the same image without DEN_API_PUBLIC_URL. */
  fallbackWebUrl: string;
  /** Browser-reachable Den API origin, exactly as DEN_API_PUBLIC_URL is configured. */
  publicApiOrigin: string;
  /** Container-internal Den API origin the /api/auth proxy must keep using. */
  internalApiOrigin: string;
  logs(service: "web" | "web-fallback" | "den"): Promise<string>;
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

export async function denComposeEval(seed: Seed): Promise<DenComposeEvalWorld> {
  const image = process.env.OPENWORK_EVAL_DEN_WEB_IMAGE?.trim();
  if (!image) {
    throw new SkipError("set OPENWORK_EVAL_DEN_WEB_IMAGE to a locally built den-web image (docker build --load -f packaging/docker/Dockerfile.den-web -t <image> .)");
  }
  await execFileAsync("docker", ["image", "inspect", image]).catch(() => {
    throw new Error(`OPENWORK_EVAL_DEN_WEB_IMAGE=${image} is not present locally; build it with docker build --load first.`);
  });

  const [webPort, apiPort, fallbackPort] = await allocateFreePorts(3);
  if (webPort === undefined || apiPort === undefined || fallbackPort === undefined) {
    throw new Error("Could not allocate host ports for the compose evaluation stack.");
  }
  const project = `openwork-eval-spec-${randomBytes(4).toString("hex")}`;
  const root = seed.tmpPath("den-compose-eval");
  await mkdir(root, { recursive: true });
  const publicApiOrigin = `http://localhost:${apiPort}`;

  // Override only what the proof needs: the image under test, never pulled,
  // and a second web container without the public API origin.
  const overridePath = join(root, "docker-compose.override.yml");
  await writeFile(overridePath, [
    "services:",
    "  web:",
    `    image: ${image}`,
    "    pull_policy: never",
    "  web-fallback:",
    "    extends:",
    `      file: ${COMPOSE_FILE}`,
    "      service: web",
    `    image: ${image}`,
    "    pull_policy: never",
    "    ports: !override",
    `      - "127.0.0.1:${fallbackPort}:3005"`,
    "    environment:",
    "      DEN_API_PUBLIC_URL: !reset null",
    "",
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENWORK_WEB_PORT: String(webPort),
    OPENWORK_API_PORT: String(apiPort),
    OPENWORK_AUTH_SECRET: randomBytes(32).toString("hex"),
    OPENWORK_DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const composeArgs = ["-p", project, "-f", COMPOSE_FILE, "-f", overridePath];
  const logs = async (service: "web" | "web-fallback" | "den") =>
    compose([...composeArgs, "logs", "--no-color", "--tail", "80", service], env).catch((error: unknown) => `logs unavailable: ${messageText(error)}`);

  const down = async () => {
    await compose([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], env)
      .catch((error: unknown) => console.error(`[openwork/testkit] compose down failed for ${project}: ${messageText(error)}`));
  };

  try {
    await compose([...composeArgs, "up", "-d", "--wait", "--wait-timeout", "240"], env);
    const webUrl = `http://127.0.0.1:${webPort}`;
    const fallbackWebUrl = `http://127.0.0.1:${fallbackPort}`;
    await waitForHealthy(`${webUrl}/api/ready`, "web", () => logs("web"));
    await waitForHealthy(`${fallbackWebUrl}/api/ready`, "web-fallback", () => logs("web-fallback"));
    await waitForHealthy(`${publicApiOrigin}/health`, "den", () => logs("den"));
  } catch (error) {
    await down();
    throw error;
  }

  return {
    project,
    image,
    webUrl: `http://127.0.0.1:${webPort}`,
    fallbackWebUrl: `http://127.0.0.1:${fallbackPort}`,
    publicApiOrigin,
    internalApiOrigin: INTERNAL_API_ORIGIN,
    logs,
    [Symbol.asyncDispose]: down,
  };
}

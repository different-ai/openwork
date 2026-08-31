import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import {
  app,
  ensureKubeStack,
  eventually,
  kindServer,
  KUBE_CLUSTER_NAME,
  KUBE_CONTEXT,
  needs,
  readDenClientState,
  resolvePlace,
  test,
} from "@openwork/testkit";

const execFileAsync = promisify(execFile);
const stateDir = fileURLToPath(new URL("../results/.kube-stack/", import.meta.url));
const apiPidPath = fileURLToPath(new URL("../results/.kube-stack/api-port-forward.pid", import.meta.url));
const webPidPath = fileURLToPath(new URL("../results/.kube-stack/web-port-forward.pid", import.meta.url));

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function endpointPort(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1) throw new Error(`Kind endpoint has no explicit port: ${url}`);
  return port;
}

test("a kind world serves its seeded admin and disposes only its port-forwards", { timeout: 900_000 }, async ({ evidence }) => {
  needs({
    optIn: ["OPENWORK_EVAL_KIND_E2E"],
    commands: ["kind", "kubectl", "helm", "docker"],
  });

  await ensureKubeStack({
    cdpCandidates: [],
    skipApp: true,
    images: "published",
    stateDir,
    log: (message) => console.error(`[openwork/testkit] ${message}`),
  });

  let apiPort = 0;
  let webPort = 0;
  {
    await using stack = new AsyncDisposableStack();
    const den = stack.use(await kindServer());
    const desktop = stack.use(await app({
      den,
      place: resolvePlace({}),
      as: "admin",
    }));
    apiPort = endpointPort(den.ref.apiUrl);
    webPort = endpointPort(den.ref.webUrl);
    const health = await fetch(`${den.ref.apiUrl}/health`);
    expect(health.status).toBe(200);

    const organizations = await denFetch(den.admin, "/v1/me/orgs", {
      headers: auth(den.admin.token),
    });
    expect(organizations.response.status).toBe(200);
    expect(organizations.body).toMatchObject({
      orgs: [{ name: "Acme Robotics", role: "owner" }],
    });
    evidence.recordAssertionEvidence(
      "The kind Den answers health and an authenticated seeded-admin route",
      `GET /health returned ${health.status}; GET /v1/me/orgs returned ${organizations.response.status} for ${den.admin.email}.`,
      true,
    );

    const clientState = await eventually(() => readDenClientState(desktop), {
      within: 30_000,
      label: "Electron app signed in to the kind Den",
      until: (state) => state.authTokenPresent && state.activeOrgName === "Acme Robotics",
    });
    expect(clientState).toMatchObject({ authTokenPresent: true, activeOrgName: "Acme Robotics" });
    evidence.recordAssertionEvidence(
      "A local Electron app signs in to the port-forwarded kind Den",
      `The desktop stored an auth token and selected ${clientState.activeOrgName}.`,
      true,
    );

    expect(den.ports).toEqual({ api: apiPort, web: webPort });
    evidence.recordAssertionEvidence(
      "The direct Kind server exposes its concrete endpoint ports",
      `The Den handle reports API port ${apiPort} and web port ${webPort}.`,
      true,
    );

    expect(Number(await readFile(apiPidPath, "utf8"))).toBeGreaterThan(0);
    expect(Number(await readFile(webPidPath, "utf8"))).toBeGreaterThan(0);
  }

  await expect(access(apiPidPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(webPidPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await portCanBind(apiPort)).toBe(true);
  expect(await portCanBind(webPort)).toBe(true);

  const namespaces = await execFileAsync("kubectl", ["--context", KUBE_CONTEXT, "get", "namespaces", "-o", "name"]);
  expect(namespaces.stdout).toContain("namespace/default");
  const clusters = await execFileAsync("kind", ["get", "clusters"]);
  expect(clusters.stdout.split(/\r?\n/)).toContain(KUBE_CLUSTER_NAME);
  evidence.recordAssertionEvidence(
    "Disposal stops the world port-forwards but leaves the kind cluster running",
    `Both pid files were removed, ports ${apiPort}/${webPort} can bind, and kubectl still listed namespace/default in ${KUBE_CONTEXT}.`,
    true,
  );
});

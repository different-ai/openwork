import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

const repoRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(repoRoot, "packages/openwork-bootstrap/bin/openwork.mjs");

export type CliRun = { status: number | null; stdout: string; stderr: string };

export type CliLogin = {
  verificationUrl: string;
  userCode: string;
  finished: Promise<CliRun>;
  stop(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDeviceEvent(line: string): { url: string; code: string } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.event !== "device_authorization") return null;
    const url = parsed.verification_uri_complete;
    const code = parsed.user_code;
    return typeof url === "string" && typeof code === "string" ? { url, code } : null;
  } catch {
    return null;
  }
}

/**
 * A person with an OpenWork account signed in on Den web, and the
 * `openwork-bootstrap` CLI on their machine with no saved credentials.
 * The CLI is the shipped Node script, run as a separate process.
 */
export async function cliDeviceLogin(seed: Seed) {
  const den = await seed.den({ org: { name: "Device Login Org", members: {} } });
  const web = await seed.web({ den, signedInAs: "admin", headless: true, viewport: { width: 1280, height: 900 } });
  const home = seed.tmpPath("cli-device-login");
  const credentialsPath = join(home, ".openwork", "credentials.json");
  const children = new Set<ReturnType<typeof spawn>>();
  const env = { ...process.env, HOME: home, OPENWORK_API_TOKEN: "", OPENWORK_CREDENTIALS_PATH: credentialsPath };

  function run(args: string[]): Promise<CliRun> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [cliPath, ...args], { env });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (status) => { children.delete(child); done({ status, stdout, stderr }); });
    });
  }

  /** Start `openwork-bootstrap login` and resolve once it has printed the link and code. */
  function startLogin(extraArgs: string[] = []): Promise<CliLogin> {
    return new Promise((ready, fail) => {
      const child = spawn(process.execPath, [cliPath, "login", "--base-url", den.ref.apiUrl, "--json", ...extraArgs], { env });
      children.add(child);
      let stdout = "";
      let stderr = "";
      let announced = false;
      const finished = new Promise<CliRun>((done) => {
        child.on("close", (status) => {
          children.delete(child);
          if (!announced) fail(new Error(`login exited before showing a code: ${stderr.slice(0, 500)}`));
          done({ status, stdout, stderr });
        });
      });
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (announced) return;
        for (const line of stderr.split("\n")) {
          const event = readDeviceEvent(line);
          if (!event) continue;
          announced = true;
          ready({ verificationUrl: event.url, userCode: event.code, finished, stop: () => child.kill("SIGTERM") });
          return;
        }
      });
    });
  }

  function savedCredentials(): { accessToken: string; baseUrl: string; mode: number } | null {
    if (!existsSync(credentialsPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath, "utf8"));
    if (!isRecord(parsed) || typeof parsed.accessToken !== "string" || typeof parsed.baseUrl !== "string") return null;
    return { accessToken: parsed.accessToken, baseUrl: parsed.baseUrl, mode: statSync(credentialsPath).mode & 0o777 };
  }

  async function me(token: string) {
    return denFetch(den.ref, "/v1/me", { method: "GET", headers: { authorization: `Bearer ${token}` } });
  }

  return {
    den,
    web,
    credentialsPath,
    run,
    startLogin,
    savedCredentials,
    me,
    async [Symbol.asyncDispose]() {
      for (const child of children) child.kill("SIGKILL");
    },
  };
}

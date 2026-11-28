import { setTimeout as delay } from "node:timers/promises";
import type { ComputerSharingState } from "@openwork/types/computer-sharing";
import { computerRunnerAccessResponseSchema, type ComputerAccessReport, type ComputerRunnerAccessResponse } from "@openwork/types/den/computers";
import { managedDesktopPolicy } from "../managed-desktop-policy.js";
import { checkSandboxPlatform, sandboxFailure } from "../sandbox-preparation.js";
import { externalFetch } from "../server-fetch.js";
import type { ServerConfig } from "../types.js";
import { createIncomingRunner, runnerBackoff, RUNNER_FEATURE_RECHECK_MS } from "./incoming-runner.js";
import { createIncomingSandbox } from "./incoming-sandbox.js";
import { getRunnerCredential, setRunnerCredential, type RunnerCredential } from "./runner-credential.js";
import { createRunnerDen, RunnerDenError } from "./runner-den.js";
import { readComputerSharingSettings, saveComputerSharingSettings, validateComputerSharingSettings } from "./sharing-settings.js";

export function createComputerSharing(config: ServerConfig, {
  fetch = externalFetch, platform = checkSandboxPlatform,
  signedIn = () => managedDesktopPolicy(config).hasDenSession(),
  allowed = async () => (await managedDesktopPolicy(config).localSandboxAccess()).enabled,
  cachedAllowed = () => managedDesktopPolicy(config).cachedLocalSandboxAllowed(),
} = {}) {
  let credential: RunnerCredential | null = null;
  let authority = new AbortController();
  let closed = false;
  let offUntil = 0;
  let revision = 0;
  let sync: ComputerSharingState["sync"] = "pending";
  let access: { expires: number; value: Promise<ComputerRunnerAccessResponse | null> } | undefined;
  let retry: AbortController | undefined;
  let reporting = Promise.resolve();
  const available = async (policy: () => boolean | Promise<boolean>): Promise<ComputerSharingState["availability"]> => {
    try { await platform(); }
    catch (error) {
      const { detail } = sandboxFailure(error);
      return detail.code === "virtualization_unavailable"
        ? { state: "unavailable", reason: "virtualization_unavailable", message: "This computer can't start the sandbox without virtualization enabled." }
        : { state: "unavailable", reason: "unsupported_platform", message: "Running code from your other computers needs the OpenWork sandbox, which needs a Mac with Apple silicon or Linux with KVM." };
    }
    if (!signedIn() || !credential || closed) return { state: "unavailable", reason: "signed_out", message: "Connect this computer to your organization before it can take work." };
    if (!await policy()) return { state: "unavailable", reason: "organization_policy", message: "Your organization needs to allow the OpenWork sandbox before this computer can take work." };
    if (offUntil > Date.now()) return { state: "unavailable", reason: "feature_off", message: "Running work on other computers is turned off for your organization." };
    return { state: "available" };
  };
  const verifiedAvailability = () => available(() => allowed().catch(() => false));
  const admission = async () => (await verifiedAvailability()).state === "available";
  const settings = () => readComputerSharingSettings(config);
  function featureOff(current: RunnerCredential) {
    if (current === credential) offUntil = Date.now() + RUNNER_FEATURE_RECHECK_MS;
  }
  function rejected(current: RunnerCredential) {
    if (getRunnerCredential(config) !== current) return;
    setRunnerCredential(config, null);
    refreshIdentity();
  }
  const sandbox = createIncomingSandbox(config, { admit: admission });
  const runner = createIncomingRunner({ sandbox, settings, available: admission, rejected, featureOff, fetch });

  function scheduleReport() {
    const current = credential;
    const signal = authority.signal;
    const generation = ++revision;
    sync = "pending";
    access = undefined;
    retry?.abort();
    if (!current || closed) return;
    const request = createRunnerDen(current, fetch);
    const backoff = retry = new AbortController();
    const isCurrent = () => !signal.aborted && generation === revision;
    async function report(attempt: number): Promise<void> {
      if (!current || !isCurrent()) return;
      let wait = runnerBackoff(attempt);
      try {
        const value = await settings();
        if (!isCurrent()) return;
        const folders = value.folders.map(({ path }) => path);
        const writableFolders = value.folders.filter(({ access }) => access === "edit").map(({ path }) => path);
        const body: ComputerAccessReport = value.enabled ? { choice: "allow", grants: value.sources.map(source => ({ source, folders, writableFolders })) } : { choice: "off", grants: [] };
        const result = await request("/v1/computer-runners/access", signal, { method: "PUT", body });
        if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("Invalid access report reply");
        if (isCurrent()) { sync = "synced"; offUntil = 0; access = undefined; }
        return;
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof RunnerDenError && error.credentialRejected) { rejected(current); return; }
        if (error instanceof RunnerDenError && error.featureOff) { featureOff(current); wait = RUNNER_FEATURE_RECHECK_MS; }
        sync = error instanceof RunnerDenError && error.capabilityRequired ? "pending" : "failed";
      }
      void delay(wait, undefined, { signal: backoff.signal, ref: false }).then(() => enqueue(attempt + 1)).catch(() => undefined);
    }
    function enqueue(attempt: number) { reporting = reporting.then(() => report(attempt)).catch(() => undefined); }
    enqueue(0);
  }

  function refreshIdentity() {
    if (closed) return;
    const latest = getRunnerCredential(config);
    if (latest === credential) return;
    authority.abort();
    authority = new AbortController();
    credential = latest;
    offUntil = 0;
    runner.update(credential);
    scheduleReport();
  }

  function readAccess() {
    const current = credential;
    const signal = authority.signal;
    if (!current || !signedIn() || offUntil > Date.now()) return Promise.resolve(null);
    if (access && access.expires > Date.now()) return access.value;
    const value = createRunnerDen(current, fetch)("/v1/computer-runners/access", signal).then(payload => {
      const result = computerRunnerAccessResponseSchema.parse(payload);
      return signal.aborted ? null : result;
    }).catch(error => {
      if (!signal.aborted && error instanceof RunnerDenError) {
        if (error.featureOff) featureOff(current);
        if (error.credentialRejected) rejected(current);
      }
      return null;
    });
    access = { value, expires: Date.now() + 15_000 };
    return value;
  }

  async function state(): Promise<ComputerSharingState> {
    const [value, report] = await Promise.all([settings(), readAccess()]);
    return {
      settings: value, availability: await verifiedAvailability(), organizationAllows: report?.organizationAllows ?? null,
      revokedSources: report?.grants.flatMap(({ source, revokedAt }) => revokedAt ? [{ source, revokedAt }] : []) ?? [], sync,
    };
  }

  refreshIdentity();
  return {
    state, refreshIdentity,
    availability: () => available(cachedAllowed),
    updateCredential(value: RunnerCredential | null) {
      if (credential?.baseUrl === value?.baseUrl && credential?.token === value?.token) return;
      setRunnerCredential(config, value);
      refreshIdentity();
    },
    async updateSettings(input: unknown) {
      const value = await validateComputerSharingSettings(config, input);
      await saveComputerSharingSettings(config, value);
      runner.update(credential);
      scheduleReport();
      return state();
    },
    async close() {
      closed = true;
      authority.abort();
      retry?.abort();
      runner.close();
      setRunnerCredential(config, null);
      credential = null;
      await sandbox.close();
    },
  };
}

const services = new WeakMap<ServerConfig, ReturnType<typeof createComputerSharing>>();
export function computerSharing(config: ServerConfig) {
  const existing = services.get(config);
  if (existing) return existing;
  const service = createComputerSharing(config);
  services.set(config, service);
  return service;
}
export async function closeComputerSharing(config: ServerConfig) {
  await services.get(config)?.close();
  services.delete(config);
}

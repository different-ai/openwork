import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { clientFailureReportSchema } from "@openwork/types/den/diagnostics";

const TTL = 14 * 86_400_000;

/** @param {{ directory: string, appVersion: string, platform?: string, arch?: string, disabled?: boolean, now?: () => number }} options */
export function createClientFailureOutbox({ directory, appVersion, platform = process.platform, arch = process.arch, disabled = false, now = Date.now }) {
  let context = null;
  let generation = 0;
  /** @type {import("@openwork/types/den/diagnostics").ClientFailureReport[]} */
  let reports = [];
  let sealed = new Set();
  let queue = Promise.resolve();
  let nextAttempt = 0;
  let failures = 0;
  let inFlight = null;
  let authorizedUntil = 0;
  let deliveryKey = null;
  const targetKey = (target) => createHash("sha256").update(JSON.stringify([target.token, target.organizationId, target.baseUrl])).digest("hex");
  try {
    const target = path.join(directory, "outbox.json");
    if (!disabled && statSync(target).size <= 262_144) {
      const saved = JSON.parse(readFileSync(target, "utf8"));
      if (/^[a-f0-9]{64}$/.test(saved?.context) && typeof saved.authorizedUntil === "number" && saved.authorizedUntil > now() && saved.authorizedUntil <= now() + TTL) {
        context = saved.context;
        deliveryKey = saved.deliveryKey;
        authorizedUntil = saved.authorizedUntil;
        nextAttempt = typeof saved.nextAttempt === "number" ? Math.min(saved.nextAttempt, now() + 3_600_000) : 0;
        failures = Number.isInteger(saved.failures) && saved.failures >= 0 ? Math.min(saved.failures, 8) : 0;
        reports = Array.isArray(saved.reports) ? saved.reports.flatMap((value) => {
          const parsed = clientFailureReportSchema.safeParse(value);
          return parsed.success && now() - Date.parse(parsed.data.occurredAt) <= TTL ? [parsed.data] : [];
        }).slice(-200) : [];
        sealed = new Set(reports.filter((report) => Array.isArray(saved.sealed) && saved.sealed.includes(report.reportId)).map((report) => report.reportId));
      }
    }
  } catch {}
  const serial = (task) => {
    queue = queue.then(task).catch(() => undefined);
    return queue;
  };
  const file = () => path.join(directory, "outbox.json");
  const prune = () => {
    reports = reports.filter((report) => now() - Date.parse(report.occurredAt) <= TTL).slice(-200);
    sealed = new Set(reports.filter((report) => sealed.has(report.reportId)).map((report) => report.reportId));
  };
  const persist = async () => {
    if (!context) return;
    prune();
    const target = file();
    const data = JSON.stringify({ context, deliveryKey, authorizedUntil, nextAttempt, failures, reports, sealed: [...sealed] });
    await mkdir(directory, { recursive: true });
    await writeFile(`${target}.tmp`, data, { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  };
  return {
    configure(input) {
      const next = !disabled && input?.enabled === true && input?.principalId && input?.organizationId && input?.denBaseUrl
        ? createHash("sha256").update(JSON.stringify([input.principalId, input.organizationId, input.denBaseUrl])).digest("hex") : null;
      authorizedUntil = next ? now() + TTL : 0;
      deliveryKey = next && input.token ? targetKey({ token: input.token, organizationId: input.organizationId, baseUrl: input.denBaseUrl }) : null;
      if (context === next) return next ? serial(persist) : queue;
      generation += 1;
      context = next;
      reports = [];
      sealed = new Set();
      inFlight = null;
      nextAttempt = 0;
      failures = 0;
      const current = generation;
      return serial(async () => {
        if (generation !== current) return;
        if (!next) { await rm(file(), { force: true }); return; }
        try {
          const raw = JSON.parse(await readFile(file(), "utf8"));
          if (generation !== current) return;
          reports = raw?.context === next && Array.isArray(raw.reports) ? raw.reports.flatMap((value) => {
            const parsed = clientFailureReportSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          }) : [];
          sealed = new Set(reports.filter((report) => Array.isArray(raw.sealed) && raw.sealed.includes(report.reportId)).map((report) => report.reportId));
          prune();
        } catch {}
        if (generation === current) await persist();
      });
    },
    /** @param {Pick<import("@openwork/types/den/diagnostics").ClientFailureReport, "component" | "phase" | "reason"> & Partial<Pick<import("@openwork/types/den/diagnostics").ClientFailureReport, "exitCode" | "httpStatus">>} failure */
    record(failure, target = null) {
      if (!context || now() >= authorizedUntil || (target && targetKey(target) !== deliveryKey)) return Promise.resolve();
      const current = generation;
      const parsed = clientFailureReportSchema.safeParse({
        schemaVersion: 1, reportId: randomUUID(), occurredAt: new Date(now()).toISOString(),
        component: failure.component, phase: failure.phase, reason: failure.reason,
        ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        appVersion, platform, arch, count: 1,
      });
      if (!parsed.success) return Promise.resolve();
      return serial(async () => {
        if (!context || generation !== current) return;
        prune();
        const last = reports.at(-1);
        const report = parsed.data;
        if (last && !sealed.has(last.reportId) && last.count < 1000 && now() - Date.parse(last.occurredAt) < 60_000
          && last.component === report.component && last.phase === report.phase && last.reason === report.reason
          && last.appVersion === report.appVersion && last.platform === report.platform && last.arch === report.arch
          && last.exitCode === report.exitCode && last.httpStatus === report.httpStatus) {
          last.count += 1;
        } else reports.push(report);
        await persist();
      });
    },
    async batch() {
      const current = generation;
      let batch = [];
      await serial(async () => {
        if (!context || generation !== current || now() < nextAttempt) return;
        prune();
        const candidate = reports.slice(0, 50).map((report) => ({ ...report }));
        if (!candidate.length) return;
        inFlight = new Set(candidate.map((report) => report.reportId));
        for (const report of candidate) sealed.add(report.reportId);
        nextAttempt = now() + 30_000;
        await persist();
        if (generation === current) batch = candidate;
      });
      return batch;
    },
    settle(ids, delivered) {
      const current = generation;
      return serial(async () => {
        if (!context || generation !== current || !inFlight) return;
        const accepted = new Set(ids.filter((id) => inFlight.has(id)));
        if (!accepted.size) return;
        if (delivered) {
          reports = reports.filter((report) => !accepted.has(report.reportId));
          nextAttempt = 0;
          failures = 0;
        } else {
          failures += 1;
          nextAttempt = now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(failures - 1, 7));
        }
        inFlight = null;
        await persist();
      });
    },
  };
}

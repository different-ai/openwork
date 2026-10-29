import assert from "node:assert/strict";
import { test } from "node:test";
import {
  serviceIdSchema, serviceReadinessReasonSchema, SERVICE_REASON_LABELS, SERVICE_STATE_LABELS,
  type DeploymentServiceReadiness,
} from "@openwork/types/den/service-readiness";
import {
  CHECK_MAX_POLLS, finishServicesRun, parseServicesSnapshot, runServicesReadiness,
  serviceRows, serviceStateLabel, servicesFailure, SERVICE_STALE_LABEL, SERVICES_VERIFY_ERROR,
} from "./service-readiness-data";

const checkedAt = "2026-10-01T12:00:00.000Z";
function snapshot(checking = false): DeploymentServiceReadiness {
  return {
    version: 2, checkedAt, checking,
    server: { version: "0.19.2", startedAt: checkedAt, startupMs: 4_100 },
    services: serviceRows(null).map((service) => ({
      ...service, configured: true, state: "ready",
      reason: service.id === "database" ? "database_verified" : service.id === "email" ? "email_verified" : "health_verified",
      durationMs: 41, checkedAt, lastSuccessAt: checkedAt,
    })),
  };
}

test("strict shared snapshots reject unknown fields, raw errors, invalid setting names, removed services and duplicates", () => {
  const report = snapshot();
  assert.deepEqual(parseServicesSnapshot(report), report);
  assert.equal(parseServicesSnapshot({ ...report, host: "https://private.example.test" }), null);
  assert.equal(parseServicesSnapshot({ ...report, version: 1 }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], error: "raw provider failure" }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], reason: "provider_error" }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], missingSettings: ["https://private.example.test"] }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [{ ...report.services[0], id: "slack" }] }), null);
  assert.equal(parseServicesSnapshot({ ...report, services: [report.services[0], report.services[0]] }), null);
});

test("all five service slots start unknown and never optimistic green", () => {
  const rows = serviceRows(null);
  assert.deepEqual(rows.map((row) => row.id), serviceIdSchema.options);
  assert.deepEqual(rows.map((row) => row.id), ["database", "gateway", "headlessRunner", "workbot", "email"]);
  assert.ok(rows.every((row) => row.state === "unknown" && row.reason === "not_checked" && row.durationMs === null && row.notes.length === 0));
  assert.ok(rows.every((row) => serviceStateLabel(row) === SERVICE_STATE_LABELS.unknown));
  assert.deepEqual(rows.filter((row) => row.required).map((row) => row.id), ["database"]);
  assert.equal(serviceRows({ version: 2, checkedAt: null, checking: true, server: null, services: [] }).length, 5);
});

test("Ready needs a successful live check: email sign-in counts, stale or configuration-only results never do", () => {
  for (const reason of serviceReadinessReasonSchema.options) assert.equal(typeof SERVICE_REASON_LABELS[reason], "string");
  const rows = snapshot().services;
  for (const row of rows) assert.equal(serviceStateLabel(row), "Ready", row.id);
  const email = rows.find((row) => row.id === "email");
  if (!email) throw new Error("email row");
  assert.equal(serviceStateLabel({ ...email, reason: "email_key_verified" }), "Ready");
  const row = rows[0];
  assert.equal(serviceStateLabel({ ...row, stale: true }), SERVICE_STALE_LABEL);
  assert.equal(serviceStateLabel({ ...row, checkedAt: null }), "Couldn't verify");
  assert.equal(serviceStateLabel({ ...row, reason: "configuration_only" }), "Couldn't verify");
  assert.equal(serviceStateLabel({ ...row, lastSuccessAt: null }), "Couldn't verify");
  const verified = new Set(["health_verified", "database_verified", "email_verified", "email_key_verified"]);
  for (const reason of serviceReadinessReasonSchema.options) {
    if (!verified.has(reason)) assert.equal(serviceStateLabel({ ...row, reason }), "Couldn't verify", reason);
  }
  assert.equal(serviceStateLabel({ ...row, state: "not_configured", reason: "not_configured" }), "Not set up");
});

test("auth loss clears details, network and cooldown failures keep the last snapshot without provider text", () => {
  const last = snapshot();
  for (const result of [servicesFailure(401), servicesFailure(403)]) {
    assert.equal(finishServicesRun(last, result).snapshot, null);
  }
  for (const result of [servicesFailure(500), servicesFailure(429), servicesFailure(404)]) {
    assert.equal(finishServicesRun(last, result).snapshot, last);
    assert.equal(result.status, "error");
  }
  assert.equal(servicesFailure(403).status, "forbidden");
  assert.equal(servicesFailure(500).message, SERVICES_VERIFY_ERROR);
});

test("an accepted check publishes cached snapshots until complete, without additional POSTs", async () => {
  let starts = 0;
  let gets = 0;
  const seen: boolean[] = [];
  const result = await runServicesReadiness({
    signal: new AbortController().signal, check: true,
    startCheck: async () => { starts += 1; return { access: "ready", data: snapshot(true) }; },
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot(gets < 2) }; },
    wait: async () => undefined,
    onSnapshot: (value) => seen.push(value.checking),
  });
  assert.deepEqual(result, { status: "ready" });
  assert.equal(starts, 1);
  assert.equal(gets, 2);
  assert.deepEqual(seen, [true, true, false]);
});

test("polling is bounded even if a server never finishes", async () => {
  let gets = 0;
  const result = await runServicesReadiness({
    signal: new AbortController().signal, check: false,
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot(true) }; },
    startCheck: async () => { throw new Error("GET refresh must never start probes"); },
    wait: async () => undefined, onSnapshot: () => undefined,
  });
  assert.equal(gets, CHECK_MAX_POLLS + 1);
  assert.equal(result.status, "error");
});

test("abort during a wait and authentication loss both stop subsequent browser requests", async () => {
  const controller = new AbortController();
  let gets = 0;
  await assert.rejects(runServicesReadiness({
    signal: controller.signal, check: true,
    startCheck: async () => ({ access: "ready", data: snapshot(true) }),
    getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot() }; },
    wait: async () => controller.abort(), onSnapshot: () => undefined,
  }));
  assert.equal(gets, 0);
  for (const status of [401, 403]) {
    const result = await runServicesReadiness({
      signal: new AbortController().signal, check: true,
      startCheck: async () => ({ access: "error", status, message: "untrusted response" }),
      getSnapshot: async () => { gets += 1; return { access: "ready", data: snapshot() }; },
      wait: async () => { throw new Error("No polling after access loss"); }, onSnapshot: () => undefined,
    });
    assert.equal(result.status, status === 401 ? "signed-out" : "forbidden");
    assert.equal(gets, 0);
  }
});

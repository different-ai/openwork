// Offline chart contract, not Kubernetes lifecycle or member-turn runtime proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@openwork/testkit";
import { denUrls } from "../../ee/packages/utils/src/den-urls.ts";

const chart = fileURLToPath(new URL("../../packaging/helm/openwork-ee/", import.meta.url));
const alias = `gwm_${"0".repeat(26)}_${"1".repeat(26)}_${"2".repeat(26)}`;
const runner = {
  "secret.create": false,
  "secret.existingSecret": "core-secrets",
  "gateway.enabled": true,
  "config.internal.gatewayProxyBaseUrl": "http://gateway:8791",
  "config.public.gatewayPublicBaseUrl": "https://models.example.test/",
  "config.public.webOrigin": "https://den.example.test/",
  "config.public.apiOrigin": "https://api.example.test/",
  "headlessRunner.enabled": true,
  "headlessRunner.persistence.enabled": true,
  "headlessRunner.model.protocol": "openai-responses",
  "headlessRunner.model.alias": alias,
  "headlessRunner.secret.existingSecret": "runner-secrets",
  "headlessRunner.secret.apiTokenKey": "runner-token",
  "headlessRunner.secret.callbackTokenKey": "callback-token",
  "headlessRunner.secret.grantKey": "grant-key",
};
const workbot = {
  ...runner,
  "workbot.enabled": true,
  "workbot.publicUrl": "https://chat.example.test/",
  "workbot.secret.existingSecret": "workbot-secrets",
  "workbot.secret.sessionSecretKey": "session-key",
};

function render(values: Record<string, string | boolean> = {}, failure?: string, chartPath = chart) {
  const args = Object.entries(values).flatMap(([key, value]) => [typeof value === "boolean" ? "--set" : "--set-string", `${key}=${value}`]);
  const result = spawnSync("helm", ["template", "contract", chartPath, "--skip-tests", ...args], { encoding: "utf8" });
  assert.ifError(result.error);
  if (failure) {
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(failure), result.stderr);
    assert.ok(!result.stderr.includes("do-not-disclose"), "validation must not echo configuration values");
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return result.stdout;
}

function document(yaml: string, kind: string, name: string) {
  const found = yaml.split(/^---$/m).find(part => part.includes(`kind: ${kind}\n`) && part.includes(`\n  name: contract-openwork-ee-${name}\n`));
  assert.ok(found, `${kind} ${name} exists`);
  return found;
}

function env(yaml: string, name: string) {
  const entry = new RegExp(`^            - name: ${name}\\n((?: {14}[^\\n]*\\n|\\n)+)`, "m").exec(yaml)?.[1];
  assert.ok(entry, `${name} is present exactly once`);
  assert.equal((yaml.match(new RegExp(`- name: ${name}\\n`, "g")) ?? []).length, 1);
  return entry;
}

function value(yaml: string, name: string, expected: string) {
  assert.ok(env(yaml, name).includes(`value: ${JSON.stringify(expected)}`), `${name} = ${expected}`);
}

function secret(yaml: string, name: string, secretName: string, key: string) {
  const entry = env(yaml, name);
  assert.ok(entry.includes("valueFrom:\n"));
  assert.ok(entry.includes(`name: "${secretName}"`));
  assert.ok(entry.includes(`key: "${key}"`));
  assert.ok(entry.includes("optional: false"));
  assert.ok(!entry.includes("value:"));
}

test("an operator starts with core only and keeps manual companion configuration", ({ evidence }) => {
  const output = render();
  assert.ok(!output.includes("headless-runner"));
  assert.ok(!output.includes("workbot"));
  assert.ok(!output.includes("kind: PersistentVolumeClaim"));
  const manual = render({ "denApi.env.DEN_HEADLESS_RUNNER_URL": "http://manual:8795", "denApi.env.DEN_WORKBOT_URL": "https://manual.example.test", "denWeb.env.DEN_WORKBOT_URL": "https://manual.example.test" });
  value(document(manual, "Deployment", "den-api"), "DEN_HEADLESS_RUNNER_URL", "http://manual:8795");
  value(document(manual, "Deployment", "den-api"), "DEN_WORKBOT_URL", "https://manual.example.test");
  value(document(manual, "Deployment", "den-web"), "DEN_WORKBOT_URL", "https://manual.example.test");
  evidence.recordAssertionEvidence("core remains default-off", "No companion workloads, PVC or Den injection; existing manual env overrides still render", true);
});

test("an operator connects Den to one private runner with targeted secrets and persistent SQLite", ({ evidence }) => {
  const output = render(runner);
  const pod = document(output, "Deployment", "headless-runner");
  assert.ok(pod.includes("replicas: 1\n"));
  assert.ok(pod.includes("type: Recreate\n"));
  assert.ok(pod.includes("mountPath: /var/data"));
  assert.ok(pod.includes("value: /var/data/headless.sqlite"));
  assert.ok(!pod.includes("envFrom:"));
  assert.ok(!pod.includes("MODEL_API_KEY"));
  assert.ok(!pod.includes("kind: Secret"));
  assert.ok(document(output, "Service", "headless-runner").includes("type: ClusterIP"));
  const pvc = document(output, "PersistentVolumeClaim", "headless-runner");
  assert.ok(pvc.includes("helm.sh/resource-policy: keep"));
  assert.ok(pvc.includes("accessModes: [ReadWriteOnce]"));
  assert.ok(!pvc.includes("storageClassName:"));
  value(pod, "HEADLESS_MODEL_PROTOCOL", "openai-responses");
  value(pod, "HEADLESS_MODEL", alias);
  value(pod, "HEADLESS_MODEL_BASE_URL", "https://models.example.test/api/v1");
  value(pod, "HEADLESS_MCP_URL", "https://api.example.test/mcp/agent");
  value(pod, "HEADLESS_DEN_API_URL", "https://api.example.test");
  secret(pod, "HEADLESS_API_TOKEN", "runner-secrets", "runner-token");
  secret(pod, "HEADLESS_DEN_CALLBACK_TOKEN", "runner-secrets", "callback-token");
  secret(pod, "HEADLESS_GRANT_KEY", "runner-secrets", "grant-key");
  const api = document(output, "Deployment", "den-api");
  value(api, "DEN_HEADLESS_RUNNER_URL", "http://contract-openwork-ee-headless-runner:8795");
  secret(api, "DEN_HEADLESS_RUNNER_TOKEN", "runner-secrets", "runner-token");
  secret(api, "DEN_HEADLESS_RUNNER_CALLBACK_TOKEN", "runner-secrets", "callback-token");
  assert.ok(!document(output, "Deployment", "den-web").includes("DEN_HEADLESS_RUNNER_"));
  assert.ok(!output.includes("DEN_WORKBOT_URL"));
  evidence.recordAssertionEvidence("private single-writer wiring", "One Recreate replica, RWO retained PVC, API/callback/grant secret refs, derived Gateway and public Den URLs", true);
});

test("an operator adds Workbot through TLS ingress or an existing HTTPS edge", ({ evidence }) => {
  const output = render({ ...workbot, "workbot.ingress.enabled": true, "workbot.ingress.tlsSecretName": "workbot-tls", "workbot.ingress.className": "nginx", "image.tag": "0.99.123", "customCa.enabled": true, "customCa.existingConfigMap": "private-ca" });
  const ingress = document(output, "Ingress", "workbot");
  assert.ok(ingress.includes('host: "chat.example.test"'));
  assert.ok(ingress.includes('secretName: "workbot-tls"'));
  assert.ok(ingress.includes('ingressClassName: "nginx"'));
  assert.ok(!output.includes("kind: Secret"), "operator secrets are never chart-owned");
  for (const component of ["den-api", "den-web", "headless-runner", "workbot"]) {
    const deployment = document(output, "Deployment", component);
    assert.match(deployment, /image: "[^"\n]+:0\.99\.123"/);
    value(deployment, "NODE_EXTRA_CA_CERTS", "/etc/openwork/custom-ca/ca-bundle.pem");
    assert.ok(deployment.includes('name: "private-ca"'));
  }
  const pod = document(output, "Deployment", "workbot");
  assert.ok(pod.includes("type: RollingUpdate\n"));
  assert.ok(!pod.includes("type: Recreate\n"));
  value(pod, "WORKBOT_PUBLIC_URL", "https://chat.example.test");
  value(pod, "WORKBOT_DEN_API_URL", "https://api.example.test");
  value(pod, "WORKBOT_DEN_WEB_URL", "https://den.example.test");
  value(pod, "WORKBOT_RUNNER_URL", "http://contract-openwork-ee-headless-runner:8795");
  secret(pod, "WORKBOT_RUNNER_TOKEN", "runner-secrets", "runner-token");
  secret(pod, "WORKBOT_SESSION_SECRET", "workbot-secrets", "session-key");
  for (const component of ["den-api", "den-web"]) value(document(output, "Deployment", component), "DEN_WORKBOT_URL", "https://chat.example.test");
  assert.ok(!render(workbot).includes("kind: Ingress"), "existing edge requires no chart ingress");
  evidence.recordAssertionEvidence("Workbot public origin is consistent", "Den API, Den Web and Workbot share the HTTPS origin; TLS host and secret match; custom CA reaches both companions", true);
});

test("an operator disables Workbot then the runner without retaining live workloads or losing the claim", ({ evidence }) => {
  const runnerOnly = render({ ...workbot, "workbot.enabled": false, "workbot.ingress.enabled": true });
  assert.ok(!runnerOnly.includes("DEN_WORKBOT_URL"));
  assert.ok(!runnerOnly.includes("kind: Ingress"));
  assert.ok(!runnerOnly.includes("component: workbot"));
  value(document(runnerOnly, "Deployment", "den-api"), "DEN_HEADLESS_RUNNER_URL", "http://contract-openwork-ee-headless-runner:8795");
  const stopped = render({ ...workbot, "workbot.enabled": false, "headlessRunner.enabled": false });
  assert.ok(!stopped.includes("DEN_HEADLESS_RUNNER_"));
  assert.ok(!stopped.includes("DEN_WORKBOT_URL"));
  assert.ok(!stopped.includes("component: workbot"));
  assert.equal((stopped.match(/component: headless-runner/g) ?? []).length, 1, "only retained PVC remains");
  document(stopped, "PersistentVolumeClaim", "headless-runner");
  const reused = render({ ...workbot, "headlessRunner.persistence.existingClaim": "retained-data" });
  assert.ok(!reused.includes("kind: PersistentVolumeClaim"));
  assert.ok(document(reused, "Deployment", "headless-runner").includes('claimName: "retained-data"'));
  const unchanged = render(workbot);
  document(unchanged, "PersistentVolumeClaim", "headless-runner");
  assert.ok(!unchanged.includes("kind: Job" + "\nmetadata:\n  name: purge"));
  evidence.recordAssertionEvidence("rendered disable is a workload removal", "Workbot off preserves runner wiring; runner off removes all chart-injected Den settings, retaining only PVC; existingClaim remounts without ownership", true);
});

test("an operator retains the configured entry feature independently of companion workload switches", ({ evidence }) => {
  assert.ok(!render().includes("DEN_FEATURE_WORKBOT_CONFIGURED_ENTRY"));
  for (const switches of [
    { "workbot.enabled": true, "headlessRunner.enabled": true },
    { "workbot.enabled": false, "headlessRunner.enabled": true },
    { "workbot.enabled": false, "headlessRunner.enabled": false },
  ]) {
    const output = render({ ...workbot, ...switches, "config.features.workbotConfiguredEntry": "true" });
    const config = output.split(/^---$/m).find(part => part.includes("kind: ConfigMap\n") && part.includes('DEN_FEATURE_WORKBOT_CONFIGURED_ENTRY: "true"'));
    assert.ok(config, "the shared configuration retains the operator lock");
    for (const component of ["den-api", "den-web"]) {
      assert.ok(document(output, "Deployment", component).includes("envFrom:\n            - configMapRef:"));
    }
    if (!switches["workbot.enabled"]) assert.ok(!output.includes("DEN_WORKBOT_URL"));
  }
  evidence.recordAssertionEvidence("entry policy survives disable", "The existing chart feature mapping retains the operator lock on Den API across both workload switches; default render has no new feature setting", true);
});

test("an operator can reuse pre-companion saved defaults without enabling anything", ({ evidence }) => {
  const cache = fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const temporary = mkdtempSync(path.join(cache, "helm-companions-"));
  try {
    const copied = path.join(temporary, "chart");
    cpSync(chart, copied, { recursive: true });
    const values = path.join(copied, "values.yaml");
    writeFileSync(values, readFileSync(values, "utf8").replace(/^(headlessRunner|workbot): \{\}\n/gm, ""));
    assert.equal(render({}, undefined, copied), render());
    const enabled = render(workbot, undefined, copied);
    document(enabled, "Deployment", "headless-runner");
    document(enabled, "Deployment", "workbot");
    const stopped = render({ ...workbot, "headlessRunner.enabled": false, "workbot.enabled": false }, undefined, copied);
    assert.ok(!stopped.includes("DEN_HEADLESS_RUNNER_"));
    document(stopped, "PersistentVolumeClaim", "headless-runner");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  evidence.recordAssertionEvidence("absent roots stay off", "Copied old-values shape with both roots absent renders identically; explicit opt-in and workload removal still render", true);
});

test("an operator gets aligned default image tags and a lintable opt-in chart", ({ evidence }) => {
  const args = Object.entries(workbot).flatMap(([key, setting]) => [typeof setting === "boolean" ? "--set" : "--set-string", `${key}=${setting}`]);
  const lint = spawnSync("helm", ["lint", chart, ...args], { encoding: "utf8" });
  assert.ifError(lint.error);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  const version = /^appVersion: "([^"]+)"$/m.exec(readFileSync(path.join(chart, "Chart.yaml"), "utf8"))?.[1];
  assert.ok(version);
  const output = render(workbot);
  for (const component of ["den-api", "den-web", "headless-runner", "workbot"]) {
    assert.ok(document(output, "Deployment", component).includes(`:${version}"`));
  }
  evidence.recordAssertionEvidence("opt-in chart lint and image defaults", `Helm lint passed; Den and companion images all resolve to chart appVersion ${version}`, true);
});

test("an operator can select existing storage, pull secrets and the shared CA Secret", ({ evidence }) => {
  const output = render({ ...workbot, "headlessRunner.persistence.storageClass": "", "customCa.enabled": true, "customCa.existingSecret": "custom-ca", "imagePullSecrets[0].name": "registry-auth" });
  assert.ok(document(output, "PersistentVolumeClaim", "headless-runner").includes('storageClassName: ""'));
  for (const component of ["headless-runner", "workbot"]) {
    const deployment = document(output, "Deployment", component);
    assert.ok(deployment.includes("name: registry-auth"));
    assert.ok(deployment.includes('secretName: "custom-ca"'));
    assert.ok(deployment.includes("readOnly: true"));
    assert.ok(!deployment.includes("envFrom:"));
    assert.ok(!deployment.includes("resource-policy: keep"), "retention must not keep a live Deployment");
  }
  evidence.recordAssertionEvidence("storage and certificate pass-through", "Explicit empty StorageClass and registry pull secret render; both companions mount the CA Secret read-only without broad envFrom", true);
});

test("blank API origin follows Den's DNS derivation instead of sending companions to the web host", ({ evidence }) => {
  for (const webOrigin of ["https://den.example.test", "https://den.example.test/", "https://den.example.test:443", "https://den.example.test:8443", "https://den.example.test:00443", "https://den.example.test:00444", "https://DEN.EXAMPLE.TEST", "https://api.den.example.test"]) {
    const expected = denUrls({ DEN_BASE_URL: webOrigin }).api;
    const output = render({ ...workbot, "config.public.apiOrigin": "", "config.public.webOrigin": webOrigin });
    const pod = document(output, "Deployment", "headless-runner");
    value(pod, "HEADLESS_MCP_URL", `${expected}/mcp/agent`);
    value(pod, "HEADLESS_DEN_API_URL", expected);
    value(pod, "HEADLESS_WORKBOT_DEN_API_URL", expected);
    value(document(output, "Deployment", "workbot"), "WORKBOT_DEN_API_URL", expected);
  }
  const explicit = render({ ...runner, "config.public.webOrigin": "https://192.0.2.10", "config.public.apiOrigin": "https://api.example.test" });
  value(document(explicit, "Deployment", "headless-runner"), "HEADLESS_DEN_API_URL", "https://api.example.test");
  evidence.recordAssertionEvidence("derived origin matches Den source", "Eight DNS variants match denUrls including whole-host prefix, HTTPS port normalization and nondefault ports; IP web hosts require explicit API origin", true);
});

const invalid: [Record<string, string | boolean>, string][] = [
  [{ "workbot.enabled": true }, "requires headlessRunner.enabled"],
  [{ ...runner, "gateway.enabled": false }, "requires gateway.enabled"],
  [{ ...runner, "headlessRunner.persistence.enabled": false }, "no ephemeral SQLite"],
  [{ ...runner, "headlessRunner.model.protocol": "wrong" }, "model.protocol"],
  [{ ...runner, "headlessRunner.model.alias": "do-not-disclose" }, "model.alias"],
  [{ ...runner, "headlessRunner.secret.existingSecret": "" }, "secret.existingSecret"],
  [{ ...runner, "headlessRunner.secret.apiTokenKey": "" }, "secret.apiTokenKey"],
  [{ ...runner, "headlessRunner.secret.callbackTokenKey": "runner-token" }, "keys must be distinct"],
  [{ ...runner, "headlessRunner.secret.existingSecret": "core-secrets" }, "dedicated operator-owned Secret"],
  [{ ...runner, "headlessRunner.image.tag": "mismatched" }, "matching"],
  [{ ...runner, "denWeb.image.tag": "mismatched" }, "matching"],
  [{ ...runner, "gateway.image.tag": "mismatched" }, "matching"],
  [{ ...workbot, "workbot.image.tag": "mismatched" }, "must match"],
  [{ ...runner, "denApi.env.DEN_HEADLESS_RUNNER_TOKEN": "do-not-disclose" }, "env overrides"],
  [{ ...runner, "denWeb.env.DEN_WORKBOT_URL": "https://manual.example.test" }, "env overrides"],
  [{ ...runner, "headlessRunner.env.HEADLESS_API_TOKEN": "do-not-disclose" }, "not supported"],
  [{ ...runner, "headlessRunner.replicaCount": "2" }, "not supported"],
  [{ ...workbot, "workbot.publicUrl": "http://chat.example.test" }, "workbot.publicUrl"],
  [{ ...workbot, "workbot.publicUrl": "https://chat.example.test/path" }, "workbot.publicUrl"],
  [{ ...workbot, "workbot.ingress.enabled": true }, "tlsSecretName"],
  [{ ...runner, "headlessRunner.enabled": "false" }, "YAML boolean"],
  [{ ...runner, "config.public.apiOrigin": "https://api.example.test//" }, "config.public.apiOrigin"],
  [{ ...runner, "config.public.apiOrigin": "https://api.example.test/den/api" }, "config.public.apiOrigin"],
  [{ ...workbot, "workbot.publicUrl": "https://den.example.test" }, "separate host"],
  [{ ...runner, "headlessRunner.persistence.size": "0Gi" }, "positive storage quantity"],
  [{ ...runner, "headlessRunner.secret.grantKey": "runner-token" }, "keys must be distinct"],
  [{ ...workbot, "config.public.apiOrigin": "", "workbot.publicUrl": "https://api.den.example.test" }, "separate host"],
  [{ ...workbot, "config.public.apiOrigin": "", "workbot.publicUrl": "https://api.den.example.test:443" }, "separate host"],
  [{ ...runner, "config.public.apiOrigin": "", "config.public.webOrigin": "https://192.0.2.10" }, "set config.public.apiOrigin explicitly"],
  [{ ...runner, "config.public.apiOrigin": "", "config.public.webOrigin": "https://[2001:db8::10]" }, "set config.public.apiOrigin explicitly"],
  [{ ...runner, "denApi.env.DEN_API_PUBLIC_URL": "https://other.example.test" }, "origin env overrides"],
  [{ ...runner, "denApi.env.DEN_BASE_URL": "https://other.example.test" }, "overrides chart-owned wiring"],
];
for (const [index, [settings, diagnostic]] of invalid.entries()) {
  test(`an operator gets a safe diagnostic for invalid companion configuration ${index + 1}`, ({ evidence }) => {
    render(settings, diagnostic);
    evidence.recordAssertionEvidence("invalid configuration refused", diagnostic, true);
  });
}

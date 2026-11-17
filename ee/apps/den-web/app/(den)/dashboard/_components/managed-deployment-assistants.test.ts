import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awsTargetSchema } from "@openwork/types/den/managed-deployments";
import { ManagedDeploymentAssistants } from "./managed-deployment-assistants";

const target = { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" };

test("gateway runtime renders included services, not optional runtime switches or upstream model fields", () => {
  const value = awsTargetSchema.parse({ ...target, runtimeProfile: "gateway" }).assistants;
  const html = renderToStaticMarkup(createElement(ManagedDeploymentAssistants, { profile: "gateway", value, enabled: true, onChange: () => undefined }));
  for (const label of ["Den", "Model gateway", "Managed runner", "Workbot", "Slack and Automations"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/>Included</g) ?? []).length, 5);
  assert.ok(html.includes("Cloud computers (optional)"));
  assert.ok(html.includes(">Off<"));
  for (const unwanted of ["Model key secret ARN", "Model HTTPS endpoint", "Model protocol", "Model ID", 'role="switch"']) assert.ok(!html.includes(unwanted), unwanted);
  assert.ok(html.includes("after first sign-in") || html.includes("After first sign-in"));
  assert.ok(html.includes("until those providers are configured"));
});

test("legacy runtime offers an explicit approved-update upgrade and preserves its current profile", () => {
  const value = awsTargetSchema.parse(target).assistants;
  const html = renderToStaticMarkup(createElement(ManagedDeploymentAssistants, { profile: "legacy", value, enabled: true, onUpgrade: () => undefined, onChange: () => undefined }));
  assert.ok(html.includes(">Legacy<"));
  assert.ok(html.includes("Include gateway runtime in this update"));
  assert.ok(!html.includes("Cloud computers (optional)"));
  assert.equal(value.headlessRunnerEnabled, false);
});

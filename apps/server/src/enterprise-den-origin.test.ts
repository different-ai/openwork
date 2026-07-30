import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exactEnterpriseOrigin,
  readActivatedEnterpriseDenOrigin,
} from "./enterprise-den-origin.js";

const roots: string[] = [];

async function bootstrapFile(contents: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-enterprise-origin-"));
  roots.push(root);
  const path = join(root, "desktop-bootstrap.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return path;
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

test("reduces an activation URL to its exact https origin", () => {
  expect(exactEnterpriseOrigin("https://den.customer.example")).toBe("https://den.customer.example");
  expect(exactEnterpriseOrigin("https://den.customer.example/api/den/")).toBe("https://den.customer.example");
  expect(exactEnterpriseOrigin("https://den.customer.example:8443/x")).toBe("https://den.customer.example:8443");
});

test("rejects non-https, credential-bearing, and malformed activation URLs", () => {
  for (const value of [
    "http://den.customer.example",
    "https://user:pass@den.customer.example",
    "https://den.customer.example/?token=secret",
    "https://den.customer.example/#fragment",
    "not-a-url",
    "",
    null,
    42,
  ]) {
    expect(exactEnterpriseOrigin(value)).toBeNull();
  }
});

test("reads the activated enterprise origin from desktop bootstrap state", async () => {
  const path = await bootstrapFile({
    baseUrl: "https://den.customer.example",
    enterpriseActivation: {
      activatedAt: "2026-07-20T10:00:00.000Z",
      denBaseUrl: "https://den.customer.example/api/den",
    },
  });
  expect(await readActivatedEnterpriseDenOrigin({ path })).toBe("https://den.customer.example");
});

test("returns null without a completed activation record", async () => {
  const missing = await bootstrapFile({ baseUrl: "https://den.customer.example" });
  expect(await readActivatedEnterpriseDenOrigin({ path: missing })).toBeNull();

  // A base URL alone is not proof of a provisioned tenant, and neither is an
  // activation entry whose completion timestamp is absent.
  const incomplete = await bootstrapFile({
    enterpriseActivation: { activatedAt: "", denBaseUrl: "https://den.customer.example" },
  });
  expect(await readActivatedEnterpriseDenOrigin({ path: incomplete })).toBeNull();

  const insecure = await bootstrapFile({
    enterpriseActivation: { activatedAt: "2026-07-20T10:00:00.000Z", denBaseUrl: "http://den.customer.example" },
  });
  expect(await readActivatedEnterpriseDenOrigin({ path: insecure })).toBeNull();
});

test("fails closed on unreadable or malformed bootstrap state", async () => {
  expect(await readActivatedEnterpriseDenOrigin({ path: join(tmpdir(), "definitely-absent-bootstrap.json") }))
    .toBeNull();
  const malformed = await bootstrapFile("{ not json");
  expect(await readActivatedEnterpriseDenOrigin({ path: malformed })).toBeNull();
});

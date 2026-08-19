import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detail(body: unknown): {
  automationId: string;
  revision: { id: string; version: number; digest: string; instructions: string };
} {
  const automation = isRecord(body) && isRecord(body.automation) ? body.automation : null;
  const revision = isRecord(body) && isRecord(body.revision) ? body.revision : null;
  if (!automation || typeof automation.id !== "string"
    || !revision || typeof revision.id !== "string" || typeof revision.version !== "number"
    || typeof revision.digest !== "string" || typeof revision.instructions !== "string") {
    throw new Error("Automation detail response was invalid.");
  }
  return {
    automationId: automation.id,
    revision: {
      id: revision.id,
      version: revision.version,
      digest: revision.digest,
      instructions: revision.instructions,
    },
  };
}

test("an Automation can return to an earlier definition as a new revision", async ({ evidence, place }) => {
  await using den = await server({
    place,
    org: { name: `Automation revision revert ${Date.now()}` },
  });

  const organizations = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const orgRows = isRecord(organizations.body) && Array.isArray(organizations.body.orgs)
    ? organizations.body.orgs.filter(isRecord)
    : [];
  const organizationId = String(orgRows[0]?.id ?? "");
  expect(organizations.response.status).toBe(200);
  expect(organizationId).not.toBe("");

  const headers = {
    authorization: `Bearer ${den.admin.token}`,
    "x-openwork-org-id": organizationId,
  };
  const schedule = { kind: "daily", timezone: "UTC", hour: 9, minute: 0 };
  const model = { providerId: "opencode", modelId: "big-pickle", variant: null };

  const createdResponse = await denFetch(den.admin, "/v1/automations", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Daily project brief",
      instructions: "Summarize the project in the concise format.",
      schedule,
      model,
    }),
  });
  expect(createdResponse.response.status, createdResponse.text).toBe(201);
  const created = detail(createdResponse.body);
  expect(created.revision.version).toBe(1);

  const changedResponse = await denFetch(
    den.admin,
    `/v1/automations/${encodeURIComponent(created.automationId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: "Summarize the project in the detailed format." }),
    },
  );
  expect(changedResponse.response.status, changedResponse.text).toBe(200);
  const changed = detail(changedResponse.body);
  expect(changed.revision.version).toBe(2);
  expect(changed.revision.digest).not.toBe(created.revision.digest);

  const revertedResponse = await denFetch(
    den.admin,
    `/v1/automations/${encodeURIComponent(created.automationId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: created.revision.instructions }),
    },
  );
  expect(revertedResponse.response.status, revertedResponse.text).toBe(200);
  const reverted = detail(revertedResponse.body);
  expect(reverted.revision.version).toBe(3);
  expect(reverted.revision.id).not.toBe(created.revision.id);
  expect(reverted.revision.id).not.toBe(changed.revision.id);
  expect(reverted.revision.digest).toBe(created.revision.digest);
  expect(reverted.revision.instructions).toBe(created.revision.instructions);

  evidence.recordAssertionEvidence(
    "An earlier Automation definition can be restored",
    "The API accepted the A to B to A edit sequence and returned the original behavior digest.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Restoring behavior preserves immutable history",
    "The restored definition is a distinct revision at version 3 rather than a reused historical row.",
    true,
  );
});

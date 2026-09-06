import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { GENERATED_TITLE, PRIVATE_ERROR_MARKER, REPLY, titleRecovery } from "../worlds/title-recovery.ts";

const test = spec.world(titleRecovery, { needs: { commands: ["bun"] }, timeout: 240_000 });
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sessionID(value: unknown): string {
  if (!record(value) || typeof value.id !== "string") throw new Error("Missing session id");
  return value.id;
}

test("automatic titles recover rejected model parameters once and report other failures without harming the reply", { timeout: 240_000 }, async ({ world, step, evidence }) => {
  const failed: string[] = [];
  for (const modelID of ["gpt-6-astra", "other-reasoner", "sampling", "denied", "limited", "malformed", "twice", "empty"]) {
    await step(`generate a first title with ${modelID}`, async () => {
      const id = sessionID(await world.engine("POST", "/session", {}));
      const providerID = modelID === "gpt-6-astra" ? "responses" : "compatible";
      const result = await world.engine("POST", `/session/${id}/message`, {
        model: { providerID, modelID }, variant: "xhigh",
        parts: [{ type: "text", text: "Tell me one thing about a kite in a meadow." }],
      });
      expect(record(result) && record(result.info) && result.info.error).toBeUndefined();
      expect(record(result) && Array.isArray(result.parts) && result.parts.filter(record).some((part) => part.text === REPLY)).toBe(true);
      const recovers = ["gpt-6-astra", "other-reasoner", "sampling"].includes(modelID);
      if (recovers) {
        await eventually(() => world.engine("GET", `/session/${id}`), {
          within: 15_000, until: (value) => record(value) && value.title === GENERATED_TITLE,
          label: `persisted recovered title for ${modelID}`,
        });
        await eventually(() => world.updates.some((event) => event.id === id && event.title === GENERATED_TITLE), { within: 10_000 });
        expect(await world.engine("GET", `/session/${id}`)).toMatchObject({ title: GENERATED_TITLE });
      } else {
        failed.push(id);
        expect(await world.engine("GET", `/session/${id}`)).toMatchObject({ title: expect.stringMatching(/^New session - /) });
      }
      const expectedTitles = modelID === "limited" ? 3 : recovers || modelID === "twice" ? 2 : 1;
      await eventually(() => world.requests.filter((request) => request.model === modelID && request.title).length, {
        within: 15_000, until: (count) => count === expectedTitles, label: `bounded title attempts for ${modelID}`,
      });
      const requests = world.requests.filter((request) => request.model === modelID);
      expect(requests.filter((request) => !request.title)).toHaveLength(1);
      if (!["sampling", "empty"].includes(modelID)) expect(requests.find((request) => !request.title)?.effort).toBe("xhigh");
      const titles = requests.filter((request) => request.title);
      // The engine already retries 429 responses twice; recovery must add none.
      expect(titles).toHaveLength(expectedTitles);
      if (recovers || modelID === "twice") {
        const before: unknown = JSON.parse(titles[0].body);
        if (!record(before)) throw new Error("Expected a provider request object");
        const after = JSON.parse(titles[1].body);
        if (modelID === "sampling") { delete before.temperature; expect(titles[1].temperature).toBeUndefined(); }
        else if (modelID === "gpt-6-astra") {
          if (!record(before.reasoning)) throw new Error("Expected Responses reasoning options");
          before.reasoning.effort = "low";
        }
        else before.reasoning_effort = "medium";
        expect(after).toEqual(before);
      }
    });
  }
  await step("a manually named conversation keeps its title and sends no title request", async () => {
    const id = sessionID(await world.engine("POST", "/session", { title: "My chosen name" }));
    const before = world.requests.filter((request) => request.title).length;
    await world.engine("POST", `/session/${id}/message`, {
      model: { providerID: "compatible", modelID: "other-reasoner" }, variant: "xhigh",
      parts: [{ type: "text", text: "Hello." }],
    });
    expect(await world.engine("GET", `/session/${id}`)).toMatchObject({ title: "My chosen name" });
    expect(world.requests.filter((request) => request.title)).toHaveLength(before);
  });
  await eventually(async () => (await world.diagnostics()).some((line) => line.includes("title_unconfirmed")), { within: 65_000, label: "empty title is diagnosed" });
  const diagnostics = (await world.diagnostics()).join("\n");
  for (const outcome of ["retrying_parameter", "accepted_after_recovery", "title_available", "access_rejected", "rate_or_quota_limited", "request_rejected", "title_unconfirmed"]) expect(diagnostics).toContain(outcome);
  expect(diagnostics).not.toContain(PRIVATE_ERROR_MARKER);
  expect(diagnostics).not.toContain("title-witness");
  expect(diagnostics).not.toContain("Tell me one thing");
  expect(world.requests.every((request) => !request.marker && request.auth === "Bearer title-witness")).toBe(true);
  for (const modelID of ["denied", "limited", "malformed", "twice", "empty"]) {
    expect(world.requests.filter((request) => request.title && request.model === modelID)).toHaveLength(modelID === "limited" ? 3 : modelID === "twice" ? 2 : 1);
  }
  for (const id of failed) expect(await world.engine("GET", `/session/${id}`)).toMatchObject({ title: expect.stringMatching(/^New session - /) });
  evidence.recordAssertionEvidence("Title parameter recovery is bounded, preserves chat and provider identity, persists titles and delivers session updates", "The real managed engine recovered Responses reasoning.effort, compatible reasoning_effort, and temperature rejections; each main reply completed, each recovered title persisted and reached SSE, and a manually named session sent no title request. Access, quota, unrelated parameters, repeated rejection, and empty output retained placeholders with sanitized diagnostics. No correlation marker reached the witness.", true);
});

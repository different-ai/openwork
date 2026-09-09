import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { onboardingWorld } from "./world.ts";
import { onboarding } from "./workflow.ts";
import { completionScreenshot } from "./screenshots.ts";

const test = spec.world(onboardingWorld, { timeout: 600_000 });

test("signup, invite two teammates, add tools, and complete setup without a download", async (ctx) => {
  const result = await onboarding(ctx);
  const { recordAssertionEvidence: record } = ctx.evidence;

  expect(result.organizationsBefore).toEqual([]);
  record(
    "Account created through signup",
    "No organization existed before the workspace step",
    true,
  );

  expect(result.organizations).toHaveLength(1);
  expect(result.organizations[0]).toMatchObject({ name: "Studio" });
  record(
    "One Studio workspace created",
    JSON.stringify(result.organizations),
    true,
  );

  expect(result.invitations).toHaveLength(2);
  expect(result.emails).toHaveLength(2);
  for (const email of ctx.world.invitees) {
    expect(result.invitations).toContainEqual(
      expect.objectContaining({ email, role: "member", status: "pending" }),
    );
    expect(
      result.emails.filter((message) => message.to === email),
    ).toHaveLength(1);
  }
  record(
    "Two teammates invited once as members",
    JSON.stringify({
      invitations: result.invitations,
      delivery: "development outbox",
    }),
    true,
  );

  expect(result.connections).toHaveLength(2);
  for (const name of ["Notion", "Linear"]) {
    expect(result.connections).toContainEqual(
      expect.objectContaining({
        name,
        connectedForMe: false,
        credentialMode: "per_member",
      }),
    );
  }
  record(
    "Notion and Linear added for the workspace",
    "Exactly two configurations; neither personal account is authorized",
    true,
  );

  expect(result.downloads).toEqual([]);
  expect(result.completedPath).toBe("/dashboard");
  record(
    "Setup opens the dashboard without downloading or requiring models",
    JSON.stringify({ path: result.completedPath, downloads: result.downloads }),
    true,
  );

  await ctx.world.film?.stop();
  const screenshot = await completionScreenshot(ctx.world);
  expect(screenshot.bytes).toBeGreaterThan(1_000);
  record(
    "DocShot captures the completed setup dashboard",
    JSON.stringify(screenshot),
    true,
  );
});

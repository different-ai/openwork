import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { onboardingWorld } from "./world.ts";
import { onboarding } from "./workflow.ts";
import { downloadScreenshot } from "./screenshots.ts";

const test = spec.world(onboardingWorld, { timeout: 600_000 });

test("signup, invite two teammates, add tools, and download the desktop app", async (ctx) => {
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

  const begun = result.downloads.find(
    (event) => event.event === "Browser.downloadWillBegin",
  );
  expect(begun?.suggestedFilename).toMatch(
    /^openwork-linux-x86_64-.*\.AppImage$/,
  );
  expect(result.completed?.guid).toBe(begun?.guid);
  expect(result.completed?.receivedBytes).toBeGreaterThan(1_000_000);
  expect(result.completed?.receivedBytes).toBe(result.completed?.totalBytes);
  expect(result.downloads.some((event) => event.state === "canceled")).toBe(
    false,
  );
  record(
    "Desktop installer downloaded completely",
    JSON.stringify(result.completed),
    true,
  );

  await ctx.world.film?.stop();
  const screenshot = await downloadScreenshot(ctx.world);
  expect(screenshot.bytes).toBeGreaterThan(1_000);
  record(
    "DocShot captures the settled download page",
    JSON.stringify(screenshot),
    true,
  );
});

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denRetiredStarterPlugins } from "../worlds/den-retired-starter-plugins.ts";

// Older organizations were seeded with example plugins that had nothing inside.
const test = spec.world(denRetiredStarterPlugins, {
  timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] },
});

const describe = (rows: { name: string; status: string; contents: number }[]) => rows.map((row) => `${row.name}: ${row.status}, ${row.contents} inside`).join("; ");

test("an admin of an older organization: I want Plugins to list only plugins that do something", async ({ world, user, step, evidence }) => {
  await step("given: my organization still holds the empty example plugins Den once added", async () => {
    const active = world.before.starters.filter((row) => row.status === "active");
    expect(active.map((row) => row.name)).toEqual(["Legal", "PDF Viewer", "Sales"]);
    expect(active.filter((row) => row.contents === 0).map((row) => row.name)).toEqual(["Legal", "PDF Viewer"]);
    expect(world.before.marketplace).toBe("active");
    evidence.recordAssertionEvidence(
      "the empty examples are live before any page opens",
      `Anthropic-Compatible Plugins is ${world.before.marketplace}; ${describe(world.before.starters)}`,
      true,
    );
  });

  await step("when I open Plugins in Manage, PDF Viewer and Legal are gone and Sales stays", async () => {
    await user.see({ testId: "admin-plugins" }, { text: /Sales/, timeoutMs: 120_000 });
    for (const name of world.emptyStarters) await user.notSee({ text: name });
    const after = await world.starters();
    expect(after.filter((row) => row.status === "active").map((row) => row.name)).toEqual([world.filledStarter]);
    evidence.recordAssertionEvidence(
      "opening Plugins retires only the empty examples",
      `Plugins lists Sales and neither PDF Viewer nor Legal; ${describe(after)}`,
      true,
    );
    await user.screenshot();
  });

  await step("then Maya finds Sales in My Library and no empty examples", async () => {
    const member = await world.openAs("maya", "/dashboard/library");
    const maya = user.on(member);
    await maya.see({ text: world.filledStarter }, { timeoutMs: 120_000 });
    for (const name of world.emptyStarters) await maya.notSee({ text: name });
    const library = await world.library("maya");
    expect(library).toContain(world.filledStarter);
    for (const name of world.emptyStarters) expect(library).not.toContain(name);
    evidence.recordAssertionEvidence(
      "a member's Library carries only the filled-in starter",
      `Maya's My Library plugins from Den: ${library.join(", ") || "none"}`,
      true,
    );
    await maya.screenshot();
  });

  await step("after: a reload keeps them gone, and the collection stays because Sales is still in it", async () => {
    await user.reload();
    await user.see({ testId: "admin-plugins" }, { text: /Sales/, timeoutMs: 60_000 });
    for (const name of world.emptyStarters) await user.notSee({ text: name });
    const marketplace = await world.marketplaceStatus();
    expect(marketplace).toBe("active");
    evidence.recordAssertionEvidence(
      "retirement is durable and keeps what people made",
      `After reload Plugins still lists only Sales; Anthropic-Compatible Plugins is ${marketplace} because Sales is in it`,
      true,
    );
    await user.screenshot();
  });
});

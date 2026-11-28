import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { artifactStorageWorld } from "../worlds/artifact-storage.ts";

const test = spec.world(artifactStorageWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const WITHIN = 90_000;
const UNAVAILABLE = "Saved data is unavailable. An OpenWork admin can turn it back on.";

test("a member's equipment request is saved in the artifact and a teammate sees and adds to the same list", async ({ world, user, probe, step, evidence }) => {
  const sam = user.on(world.owner);
  const riley = user.on(world.teammate);
  const samPage = probe.on(world.owner);
  const inside = { resourceUri: world.resourceUri };
  const open = async (person: typeof sam) => {
    await person.see({ role: "button", label: "Artifacts" }, { timeoutMs: WITHIN });
    await person.click({ role: "button", label: "Artifacts" });
    await person.see({ role: "button", label: `Open ${world.title}` }, { timeoutMs: WITHIN });
    await person.click({ role: "button", label: `Open ${world.title}` });
  };

  await step("before: with saved data off, the artifact says its saved data is unavailable and has no way to add anything", async () => {
    await open(sam);
    await sam.see({ role: "status", label: UNAVAILABLE, mcpApp: inside }, { timeoutMs: WITHIN });
    await sam.notSee({ role: "button", label: "Add request", mcpApp: inside });
    const tools = await world.artifactTools();
    expect(tools).toEqual(["open_app"]);
    evidence.recordAssertionEvidence("With saved data off the artifact offers only to open",
      `The artifact reads "${UNAVAILABLE}"; its MCP server lists ${tools.join(", ")}`, tools.length === 1);
    await sam.screenshot();
  });

  await step("the owner adds a request once saved data is on", async () => {
    await world.setSavedData(true);
    await sam.reload();
    await open(sam);
    await sam.see({ role: "status", label: /^0\s*requests · updated/u, mcpApp: inside }, { timeoutMs: WITHIN });
    await sam.type({ role: "textbox", label: "Item", mcpApp: inside }, "Standing desk");
    await sam.click({ role: "button", label: "Add request", mcpApp: inside });
    await sam.see({ role: "button", label: "Delete Standing desk", mcpApp: inside }, { timeoutMs: WITHIN });
    await sam.see({ role: "status", label: /^1\s*request · updated/u, mcpApp: inside }, { timeoutMs: WITHIN });
    const tools = await world.artifactTools();
    const saved = await world.savedItems();
    expect(tools).toEqual(["open_app", "storage_read", "storage_write"]);
    expect(saved).toEqual([{ item: "Standing desk", by: world.ownerName }]);
    evidence.recordAssertionEvidence("The request is a saved row, not React state",
      `The artifact's MCP server lists ${tools.join(", ")}; it holds ${saved.map((row) => `"${row.item}" by ${row.by}`).join(", ")}`,
      saved.length === 1);
    await sam.screenshot();
  });

  await step("after: the request is still there when the owner reloads and opens the artifact again", async () => {
    await sam.reload();
    await open(sam);
    await sam.see({ role: "button", label: "Delete Standing desk", mcpApp: inside }, { timeoutMs: WITHIN });
    await sam.see({ role: "status", label: /^1\s*request · updated/u, mcpApp: inside }, { timeoutMs: WITHIN });
    const frames = await samPage.dom("[data-mcp-app-resource] > iframe");
    const saved = await world.savedItems();
    expect(frames.elements).toHaveLength(1);
    expect(saved).toHaveLength(1);
    evidence.recordAssertionEvidence("A fresh page load shows the saved request",
      `After a reload ${frames.elements.length} artifact is open and it lists ${saved.length} request: ${saved[0]?.item}`, frames.elements.length === 1 && saved.length === 1);
    await sam.screenshot();
  });

  await step("the teammate opens the same artifact, sees the owner's request, and adds their own", async () => {
    await open(riley);
    await riley.see({ role: "button", label: "Delete Standing desk", mcpApp: inside }, { timeoutMs: WITHIN });
    await riley.type({ role: "textbox", label: "Item", mcpApp: inside }, "Second monitor");
    await riley.click({ role: "button", label: "Add request", mcpApp: inside });
    await riley.see({ role: "status", label: /^2\s*requests · updated/u, mcpApp: inside }, { timeoutMs: WITHIN });
    const saved = await world.savedItems();
    expect(saved).toEqual([{ item: "Standing desk", by: world.ownerName }, { item: "Second monitor", by: world.teammateName }]);
    evidence.recordAssertionEvidence("Both members' requests are in one shared list",
      saved.map((row) => `"${row.item}" by ${row.by}`).join("; "), saved.length === 2);
    await riley.screenshot();
  });

  await step("the owner reloads and sees the teammate's request beside their own", async () => {
    await sam.reload();
    await open(sam);
    await sam.see({ role: "button", label: "Delete Second monitor", mcpApp: inside }, { timeoutMs: WITHIN });
    await sam.see({ role: "status", label: /^2\s*requests · updated/u, mcpApp: inside }, { timeoutMs: WITHIN });
    const saved = await world.savedItems();
    expect(saved.map((row) => row.by)).toEqual([world.ownerName, world.teammateName]);
    evidence.recordAssertionEvidence("The owner sees the teammate's row",
      `The owner's artifact lists ${saved.length} requests, added by ${saved.map((row) => row.by).join(" and ")}`, saved.length === 2);
    await sam.screenshot();
  });

  await step("a member the artifact was never shared with, and someone not signed in, reach no rows", async () => {
    await sam.see({ role: "button", label: "Delete Second monitor", mcpApp: inside }, { timeoutMs: WITHIN });
    const outsider = await world.outsiderRead();
    const anonymous = await world.anonymousWrite();
    const after = await world.savedItems();
    expect(outsider).toEqual({ error: "mcp_app_not_found", rows: 0 });
    expect(anonymous.error).toBe("public_app_unavailable");
    expect(after).toHaveLength(2);
    evidence.recordAssertionEvidence("People without access get nothing and change nothing",
      `The unshared member's read answers ${outsider.error} with ${outsider.rows} rows; an anonymous write answers ${anonymous.error}; the list still has ${after.length} requests`,
      outsider.rows === 0 && after.length === 2);
  });

  await step("an organization admin exports the saved requests as a spreadsheet file; a plain member cannot", async () => {
    await sam.see({ role: "button", label: "Delete Standing desk", mcpApp: inside }, { timeoutMs: WITHIN });
    const admin = await world.exportCsv("admin");
    const member = await world.exportCsv("member");
    const lines = admin.text.trim().split("\r\n");
    expect(admin.status).toBe(200);
    expect(lines[0]).toContain("id,item,reason,status,created_by");
    expect(admin.text).toContain("Standing desk");
    expect(admin.text).toContain("Second monitor");
    expect(member.status).toBe(403);
    evidence.recordAssertionEvidence("The admin's export holds both rows and a member is refused",
      `Admin export: HTTP ${admin.status}, ${lines.length - 1} rows under "${lines[0]}"; member export: HTTP ${member.status}`,
      admin.status === 200 && member.status === 403);
  });
});

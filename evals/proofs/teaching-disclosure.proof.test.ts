import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { teachingDisclosure } from "../worlds/teaching-disclosure.ts";

const test = spec.world(teachingDisclosure, { timeout: 60_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a keyboard user collapses and expands the teaching window with a valid accessible panel relationship", async ({ world, user, step, evidence }) => {
  const relationship = world.relationship;
  let firstId = "";
  let secondId = "";
  await step("after: each expanded teaching window identifies its own visible panel", async () => {
    await user.see({ text: "Recorded steps (1)", nth: 0 });
    const panels = await relationship();
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel.id).not.toBe("");
      expect(panel).toMatchObject({ expanded: "true", local: true, count: 1, visible: true, bodyPresent: true });
    }
    firstId = panels[0]!.id; secondId = panels[1]!.id;
    expect(firstId).not.toBe(secondId);
    evidence.recordAssertionEvidence("Teaching controls identify separate panels", "Two expanded windows each control exactly one visible local panel, with distinct IDs.", panels.every(panel => panel.local && panel.count === 1 && panel.visible) && firstId !== secondId);
    await user.screenshot();
  });
  await step("Enter collapses only the focused window and keeps its panel relationship valid", async () => {
    await user.press("Tab"); // Teach Workbot toolbar control.
    await user.press("Tab"); // First window's collapse control.
    expect((await relationship())[0]?.focused).toBe(true);
    await user.press("Enter");
    await user.see({ role: "button", label: "Expand teaching" });
    const panels = await relationship();
    expect(panels[0]).toMatchObject({ id: firstId, expanded: "false", local: true, count: 1, visible: false, focused: true, bodyPresent: false });
    expect(panels[1]).toMatchObject({ id: secondId, expanded: "true", visible: true, bodyPresent: true });
    evidence.recordAssertionEvidence("Collapsed teaching retains its hidden target", "Enter hides the first panel, leaves its ID mounted and focus on its trigger, and does not collapse the second window.", panels[0]?.local === true && !panels[0].visible && panels[1]?.visible === true);
    await user.screenshot();
  });
  await step("Space expands the same panel without moving keyboard focus", async () => {
    await user.press("Space");
    await user.see({ role: "button", label: "Collapse teaching", nth: 0 });
    const panels = await relationship();
    expect(panels[0]).toMatchObject({ id: firstId, expanded: "true", local: true, count: 1, visible: true, focused: true, bodyPresent: true });
    evidence.recordAssertionEvidence("The same teaching panel expands from the keyboard", "Space restores the content under the original panel ID and keeps focus on the disclosure control.", panels[0]?.id === firstId && panels[0].visible && panels[0].focused);
    await user.screenshot();
  });
  await step("hiding and reopening teaching preserves the instance's panel ID", async () => {
    await user.click({ role: "button", label: "Hide teaching", nth: 0 });
    expect(await relationship()).toHaveLength(1);
    await user.click({ role: "button", label: "Teach Workbot" });
    await user.see({ role: "button", label: "Collapse teaching", nth: 0 });
    const panels = await relationship();
    expect(panels[0]).toMatchObject({ id: firstId, expanded: "true", local: true, visible: true });
    expect(panels[1]?.id).toBe(secondId);
    evidence.recordAssertionEvidence("Reopening teaching keeps stable, separate relationships", "The reopened window reuses its original panel ID; the other window's ID is unchanged.", panels[0]?.id === firstId && panels[1]?.id === secondId);
    await user.screenshot();
  });
});

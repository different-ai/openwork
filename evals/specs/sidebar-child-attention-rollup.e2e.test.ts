import { expect } from "vitest";
import { browserScript } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { parentChildPermissionWorld } from "../worlds/first-run.ts";

// A delegated child's pending permission lives on the child's activity
// record. The parent row must show the orange "needs you" dot naming that
// child, not the working spinner, and agents asking list_sessions must see
// the parent as waiting. Answering the request returns the spinner.

const test = spec.world(parentChildPermissionWorld);

const CHILD_TITLE = "Investigate the deployment failure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("a delegated child's pending permission turns the parent's sidebar row orange and its agent-visible status to waiting", async ({ world, user, agent, probe, step }) => {
  const parentId = world.session.sessionId;
  // TODO(primitive): read a sidebar row's indicator through a first-class primitive.
  const rowIndicator = () => probe.eval(browserScript((id) => {
    const row = document.querySelector<HTMLElement>('[data-sidebar-session-id="' + id + '"]');
    const dot = row?.querySelector<HTMLElement>("[data-session-attention-indicator]");
    return {
      spinner: Boolean(row?.querySelector<HTMLElement>("[data-session-loading-indicator]")),
      dot: dot instanceof HTMLElement ? { title: dot.title, ariaLabel: dot.getAttribute("aria-label"), source: dot.dataset.sessionAttentionSource ?? null } : null,
      ariaLabel: row?.querySelector<HTMLElement>('[data-testid="sidebar-session-' + id + '"]')?.getAttribute("aria-label") ?? null,
    };
  }, [parentId]));
  const listedParent = async () => {
    const listed = await agent.run("session.list_sessions");
    if (!Array.isArray(listed)) throw new Error("list_sessions did not return a list");
    return listed.find((entry) => isRecord(entry) && entry.sessionId === parentId);
  };

  await step("the parent row needs you and names the blocked child while the transcript shows the same request", async () => {
    await user.see({ text: /Needs permission/ }, { timeoutMs: 30_000 });
    await user.see({ text: new RegExp(`Requested by ${CHILD_TITLE}`) });
    const indicator = await probe.eventually(rowIndicator, {
      within: 15_000, label: "the parent's sidebar row shows the orange needs-you dot for its child",
      until: (value) => value.dot?.source === "child",
    });
    expect(indicator).toEqual({
      spinner: false,
      dot: { title: `Needs permission: ${CHILD_TITLE}`, ariaLabel: `Needs permission: ${CHILD_TITLE}`, source: "child" },
      ariaLabel: expect.stringContaining(`Needs permission: ${CHILD_TITLE}`),
    });
    const parent = await probe.eventually(listedParent, {
      within: 15_000, label: "session.list_sessions reports the parent as waiting",
      until: (entry) => isRecord(entry) && entry.status === "waiting",
    });
    expect(parent).toMatchObject({ sessionId: parentId, status: "waiting", working: true });
    await user.screenshot();
  });

  await step("answering the child's request returns the parent row to the working spinner", async () => {
    await user.click("Allow once");
    await user.notSee({ text: new RegExp(`Requested by ${CHILD_TITLE}`) }, { timeoutMs: 15_000 });
    const indicator = await probe.eventually(rowIndicator, {
      within: 15_000, label: "the parent's sidebar row returns to the working spinner",
      until: (value) => value.spinner && value.dot === null,
    });
    expect(indicator).toMatchObject({ spinner: true, dot: null });
    const parent = await probe.eventually(listedParent, {
      within: 15_000, label: "session.list_sessions reports the parent as working again",
      until: (entry) => isRecord(entry) && entry.status !== "waiting",
    });
    expect(parent).toMatchObject({ sessionId: parentId, status: "thinking", working: true });
    await user.screenshot();
  });
});

import { spec } from "@openwork/testkit";
import { externalSessionVisibility } from "../worlds/session-shell.ts";

const test = spec.world(externalSessionVisibility);

test("incoming messages show their source live and after reopening a task", { timeout: 15 * 60_000 }, async ({ world, user, agent, step, skip }) => {
  if (world.engine !== "v1") skip("needs: v1 text-part metadata; v2 preview does not preserve prompt metadata");
  const workspaceId = world.home.workspaceId;
  const sessionId = await world.createSessionOutsideWindow(workspaceId, "Message sources");
  const parkingId = await world.createSessionOutsideWindow(workspaceId, "Other work");
  await agent.run("workspace.reload_sessions", { workspaceId });
  await agent.run("session.open", { sessionId, workspaceId });
  await step("ordinary messages have no inferred source", async () => {
    await world.submitAttributedMessage(workspaceId, sessionId, "From automation is just text in this message");
    await user.see({ text: "From automation is just text in this message" });
    await user.notSee({ text: "From another task" });
    await user.notSee({ text: "From remote session · Cloud" });
  });
  const examples: Array<{ source: Record<string, string>; label: string }> = [
    { source: { kind: "automation", name: "Daily brief", surface: "desktop" }, label: "From automation · Daily brief · Desktop" },
    { source: { kind: "automation", surface: "cloud" }, label: "From automation · Cloud" },
    { source: { kind: "task" }, label: "From another task" },
    { source: { kind: "remote-session", surface: "desktop" }, label: "From remote session · Desktop" },
    { source: { kind: "remote-session", surface: "cloud" }, label: "From remote session · Cloud" },
  ];
  for (const { source, label } of examples) {
    await step(`${label} survives reopening`, async () => {
      await world.submitAttributedMessage(workspaceId, sessionId, `Please review item ${examples.findIndex((item) => item.label === label) + 1}`, source);
      await user.see({ text: label });
      await agent.run("session.open", { sessionId: parkingId, workspaceId });
      await user.notSee({ text: label });
      await agent.run("session.open", { sessionId, workspaceId });
      await user.see({ text: label });
    });
  }
  await user.screenshot();
});

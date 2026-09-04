import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerUseWorld, toolState } from "../worlds/computer-use.ts";

// New journey: a person grants one native window and can revoke it. The helper
// is a real stdio process; the fixture app has two independent, disposable windows.
const test = spec.world(computerUseWorld, { timeout: 180_000 });

test("Computer Use respects window consent, fresh observations and the person's Stop control", async ({ world, step }) => {
  await step("Discovery exposes identities without window content or input access", async () => {
    const discovery = toolState(await world.call("computer_discover"));
    expect(discovery.protocol).toBe("openwork.computer-use/1");
    expect(JSON.stringify(discovery)).not.toContain("Initial draft");
    const unapproved = await world.call("computer_observe", { session_id: "invented" });
    expect(unapproved).toMatchObject({ isError: true });
    expect(toolState(unapproved).code).toBe("session_unavailable");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  const session = await step("The person chooses a window and grants app controls", async () => {
    const pending = world.call("computer_open_session", { app_id: world.appId, mode: "assist", purpose: "Edit the disposable fixture draft and increment its counter." });
    // A trusted person-input fixture presses the real native approval button.
    await Promise.race([
      world.pressControl("Allow this session"),
      pending.then((reply) => {
        const state = toolState(reply);
        if (state.ok !== true) throw new Error(`Session did not request consent: ${JSON.stringify(state)}`);
        return new Promise<never>(() => {});
      }),
    ]);
    const result = toolState(await pending);
    expect(result).toMatchObject({ ok: true, mode: "assist", window_title: "Workspace window" });
    expect(typeof result.session_id).toBe("string");
    return result.session_id;
  });

  await step("A different connection cannot read or act through the grant", async () => {
    const other = await world.peerCall("computer_observe", { session_id: session });
    expect(other).toMatchObject({ isError: true });
    expect(toolState(other).code).toBe("session_unavailable");
    const busy = toolState(await world.peerCall("computer_open_session", { app_id: world.appId, mode: "assist", purpose: "Try a second session." }));
    expect(busy.code).toBe("computer_busy");
  });

  const observe = async () => toolState(await world.call("computer_observe", { session_id: session }));
  const refFor = (state: Record<string, unknown>, text: string) => {
    if (!Array.isArray(state.elements)) throw new Error("No accessible elements");
    const match = state.elements.find((value: unknown) => typeof value === "object" && value !== null && "label" in value && value.label === text);
    if (typeof match !== "object" || match === null || !("ref" in match)) throw new Error(`Missing accessible control: ${text}`);
    return match.ref;
  };
  const action = (observation: Record<string, unknown>, request: string, input: Record<string, unknown>) =>
    world.call("computer_act", { session_id: session, observation_id: observation.observation_id, request_id: request, action: input });

  await step("Only the approved window is read and its protected field is omitted", async () => {
    const observed = await observe();
    expect(observed.ok).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("Other increment");
    expect(JSON.stringify(observed)).not.toContain("private-fixture-value");
    expect(observed.protected_fields).toBe(1);
    const denied = toolState(await action(observed, "visual-denied", { type: "click", x: 20, y: 20 }));
    expect(denied.code).toBe("scope_denied");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("Accessible actions update the selected window once and leave the other window alone", async () => {
    const observed = await observe();
    const press = { type: "press", ref: refFor(observed, "Increment") };
    const receipt = toolState(await action(observed, "increment-once", press));
    expect(receipt).toMatchObject({ ok: true, status: "dispatched", outcome_verified: false });
    expect(toolState(await action(observed, "increment-once", press))).toEqual(receipt);
    expect(toolState(await action(observed, "different-request", press)).code).toBe("observation_required");
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Initial draft" });
    const next = await observe();
    expect(toolState(await action(next, "write-draft", { type: "set_value", ref: refFor(next, "Draft text"), text: "Reviewed 👋🏽" })).ok).toBe(true);
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed 👋🏽" });
  });

  await step("A resized window and a paused session reject old observations", async () => {
    const observed = await observe();
    await world.resize();
    expect(toolState(await action(observed, "stale-layout", { type: "press", ref: refFor(observed, "Increment") })).code).toBe("stale_observation");
    await world.pressControl("Pause");
    expect(toolState(await world.call("computer_observe", { session_id: session })).code).toBe("session_paused");
    await world.pressControl("Resume");
    expect((await observe()).ok).toBe(true);
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed 👋🏽" });
  });

  await step("Stop revokes the session immediately and leaves both windows intact", async () => {
    await world.pressControl("Stop");
    expect(toolState(await world.call("computer_observe", { session_id: session })).code).toBe("session_unavailable");
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed 👋🏽" });
    expect(toolState(await world.call("cua_screenshot")).code).toBe("unknown_tool");
  });
});

import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { agentVisibility } from "../worlds/agent-visibility.ts";

const test = spec.world(agentVisibility, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

type Sample = { at: number; working: string | null; liveHeight: number | null; helperRow: boolean; startupLeak: boolean; liveModels: number; shimmer: { text: string; position: string; weight: string; color: string; gradient: string; statusColor: string; animation: string; reduced: boolean }[] };

test(`AGENT-VIS-01 ${resolveEvalEngine()}: a person asks a research question and can always tell the agent is still working`, async ({ world, user, probe, step, evidence }) => {
  const samples: Sample[] = [];
  // TODO(primitive): no probe reads "is any Working line visible" plus the live-steps height
  // in one glance; sampling both together is the only way to catch a flicker between steps.
  const readScreen = () => probe.eval(() => {
    // The turn's own "Working 12s" line. A helper row carries its own timer, which is not
    // the turn's, so text inside helper rows is removed before looking.
    const candidates = [...document.querySelectorAll<HTMLElement>("[data-loading-message], [data-live-steps], [data-message-id]")];
    const turnText = (node: HTMLElement) => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[data-subagent-run]").forEach((row) => row.remove());
      return copy.textContent?.match(/Working\s*\d+(?:m\s*\d+)?s/)?.[0] ?? null;
    };
    const working = candidates.map(turnText).find((text) => text !== null) ?? null;
    const live = document.querySelector<HTMLElement>("[data-live-steps]");
    return {
      startupLeak: /0 earlier steps|Starting the engine|Starting engine/.test(document.body.innerText),
      liveModels: live?.querySelectorAll('[data-testid="reply-model"]').length ?? 0,
      // TODO(primitive): read the painted shimmer position across real animation frames.
      shimmer: [...document.querySelectorAll<HTMLElement>('[data-live-steps] .ow-text-shimmer')]
        .filter(node => node.getBoundingClientRect().height > 0)
        .map(node => ({ text: node.innerText, position: getComputedStyle(node).backgroundPosition,
          weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color,
          gradient: getComputedStyle(node).backgroundImage,
          statusColor: getComputedStyle(node.closest('[data-subagent-run]')?.querySelector('button > span:nth-child(2)') ?? node).color,
          animation: getComputedStyle(node).animationName,
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })),
      working,
      liveHeight: live ? Math.round(live.getBoundingClientRect().height) : null,
      helperRow: Boolean(document.querySelector("[data-subagent-run]")),
    };
  });

  await step("before: the person starts work in the familiar chat layout", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.prompt });
    await user.screenshot();
  });

  await step("while the agent reads, runs a slow command and starts a helper, a Working line never leaves the screen", async () => {
    const started = Date.now();
    // Sample like a person glancing at the screen: every 150 ms, until the helper is running.
    while (Date.now() - started < 60_000) {
      const screen = await readScreen();
      samples.push({ at: Date.now() - started, ...screen });
      if (screen.helperRow && samples.filter((sample) => sample.helperRow).length >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const firstWorking = samples.findIndex((sample) => sample.working !== null);
    const afterStart = firstWorking >= 0 ? samples.slice(firstWorking) : samples;
    const gaps = afterStart.filter((sample) => sample.working === null);
    evidence.recordJsonArtifact("What the person saw every 150 ms", samples);
    evidence.recordAssertionEvidence(
      "Working stays on screen for the whole run",
      `${afterStart.length - gaps.length} of ${afterStart.length} glances showed a Working line; missing at ${gaps.map((gap) => `${gap.at}ms`).join(", ") || "none"}`,
      firstWorking >= 0 && gaps.length === 0,
    );
    await user.screenshot();
    expect(firstWorking, "a Working line appears after sending").toBeGreaterThanOrEqual(0);
    expect.soft(gaps.map((gap) => gap.at), "glances where Working had disappeared").toEqual([]);
  });

  await step("a running title moves without changing weight or exposing internal state", async () => {
    const held = samples.flatMap(sample => sample.shimmer).filter(sample => sample.text.includes("Check the error log"));
    expect(held.length).toBeGreaterThanOrEqual(5);
    const weights = [...new Set(held.map(sample => sample.weight))];
    const positions = [...new Set(held.map(sample => sample.position))];
    expect(weights).toHaveLength(1);
    expect(new Set(held.map(sample => sample.color)).size).toBe(1);
    expect(new Set(held.map(sample => sample.gradient)).size).toBe(1);
    expect(new Set(held.map(sample => sample.statusColor)).size).toBe(1);
    if (held[0]?.reduced) expect(held.every(sample => sample.animation === "none")).toBe(true);
    else { expect(positions.length).toBeGreaterThan(1); expect(held.every(sample => sample.animation === "ow-text-shimmer")).toBe(true); }
    expect(samples.every(sample => !sample.startupLeak && sample.liveModels === 0)).toBe(true);
    evidence.recordAssertionEvidence("Shimmer advances on the visible running title without weight flicker",
      `${held.length} native-runtime samples; ${positions.length} painted background positions; weights: ${weights.join(", ")}; reduced motion: ${held[0]?.reduced}`, true);
    evidence.recordAssertionEvidence("The live rail keeps internal startup and model labels out",
      `${samples.length} samples contained no zero-step or engine-start label and no model badge inside live steps`, true);
    await user.screenshot();
  });

  await step("the turn's timer only counts up while it runs", async () => {
    const seconds = samples.map((sample) => sample.working?.match(/(?:(\d+)m\s*)?(\d+)s/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => Number(match[1] ?? 0) * 60 + Number(match[2]));
    const backwards = seconds.slice(1).map((value, index) => ({ from: seconds[index]!, to: value })).filter((pair) => pair.to < pair.from);
    evidence.recordAssertionEvidence(
      "The Working timer never jumps back",
      `${seconds.length} readings from ${seconds[0] ?? "-"}s to ${seconds.at(-1) ?? "-"}s; ${backwards.length} jumps back (${backwards.map((pair) => `${pair.from}→${pair.to}`).join(", ") || "none"})`,
      backwards.length === 0,
    );
    expect.soft(backwards, "Working timer jumps back").toEqual([]);
  });

  await step("the running steps never shrink under the person's eyes", async () => {
    const heights = samples.map((sample) => sample.liveHeight).filter((height): height is number => height !== null);
    const shrinks = heights.slice(1).map((height, index) => heights[index]! - height).filter((drop) => drop > 8);
    evidence.recordAssertionEvidence(
      "The live steps area only grows while the turn runs",
      `${heights.length} measurements, ${shrinks.length} drops over 8px (${shrinks.join(", ") || "none"})`,
      shrinks.length === 0,
    );
    expect.soft(shrinks, "height drops of the live steps area").toEqual([]);
  });

  await step("the helper shows as its own row the person can open", async () => {
    await user.see({ text: "Check the error log" }, { timeoutMs: 30_000 });
    const rows = await probe.dom("[data-subagent-run]");
    evidence.recordAssertionEvidence("One helper row is visible", `${rows.elements.length} helper row(s)`, rows.elements.length === 1);
    expect(rows.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: the helper finishes, the answer arrives, and the turn ends cleanly", async () => {
    await world.releaseHelper();
    await user.see({ role: "button", label: /^Thinking/ }, { timeoutMs: 90_000 });
    await user.notSee({ text: world.reasoning });
    await user.notSee({ text: world.answer });
    const thinking = await probe.dom('[data-reasoning-block]');
    expect(thinking.elements).toHaveLength(1);
    await user.screenshot();
    await user.click({ role: "button", label: /^Thinking/ });
    await user.see({ text: world.reasoning });
    await user.notSee({ text: world.answer });
    await user.click({ role: "button", label: /^Thinking/ });
    await probe.eventually(() => probe.text(), { within: 5_000, intervalMs: 50,
      label: "reasoning disclosure finishes closing", until: text => !text.includes(world.reasoning) });
    await user.notSee({ text: world.reasoning });
    evidence.recordAssertionEvidence("Thinking stays separate from the answer",
      "The native reasoning stream shows Thinking with no answer; its text appears only after opening the disclosure and hides again when folded", true);
    await world.releaseAnswer();
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /Working\s*\d/ });
    // TODO(primitive): verify answer-level model placement while the completed rail is folded.
    const settled = await probe.eval(() => ({
      visibleModels: [...document.querySelectorAll<HTMLElement>('[data-testid="reply-model"]')]
        .filter(node => node.getBoundingClientRect().height > 0).map(node => node.innerText.replace(/^\s*·\s*/, "").trim()),
      liveSteps: document.querySelectorAll('[data-live-steps]').length,
      liveShimmers: [...document.querySelectorAll<HTMLElement>('.ow-text-shimmer')]
        .filter(node => node.getBoundingClientRect().height > 0).length,
    }));
    expect(settled).toMatchObject({ visibleModels: [], liveSteps: 0, liveShimmers: 0 });
    evidence.recordJsonArtifact("Finished reply layout", settled);
    await user.click({ role: "button", label: /Worked for.*Show steps/ });
    await user.see({ role: "button", label: /^Thought/ });
    await user.notSee({ text: world.reasoning });
    await user.click({ role: "button", label: /Worked for.*Hide steps/ });
    evidence.recordAssertionEvidence("Finished work folds without inventing a resolved model",
      "Long work folds; this mock reports an unresolved requested model, so no model badge is invented. Trusted resolved-model placement has focused component coverage.", true);
    evidence.recordAssertionEvidence("The turn ends cleanly", "answer shown, composer back to Run task, no Working line left", true);
    await user.screenshot();
  });

  await step("the agent really did what the person watched: read, command, helper", async () => {
    const tools = (await world.requests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const helperTools = (await world.helperRequests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const expected = ["read", "read", "read", world.shell, world.engine === "v2" ? "subagent" : "task"];
    evidence.recordAssertionEvidence("Model calls match the screen", `parent: ${tools.join(" → ")}; helper: ${helperTools.join(" → ")}`,
      JSON.stringify(tools) === JSON.stringify(expected) && helperTools.length === 1);
    expect(tools).toEqual(expected);
    expect(helperTools).toEqual([world.shell]);
  });
});

test(`AGENT-VIS-02 ${resolveEvalEngine()}: a person follows up while a helper works, then stops, and nothing they typed is lost or sent behind their back`, async ({ world, user, probe, step, evidence }) => {
  await step("the person starts the research and the helper begins working", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: "Check the error log" }, { timeoutMs: 60_000 });
    await user.see("Stop");
    await user.screenshot();
  });

  await step("they add a follow-up with Enter, and it waits instead of interrupting", async () => {
    await user.type("composer", world.followUp, { verify: true });
    await user.press("Enter");
    await user.see({ text: /1 queued/ }, { timeoutMs: 10_000 });
    const delivered = (await world.followUpRequests()).length;
    evidence.recordAssertionEvidence("The follow-up waits for the current run", `shows "1 queued"; the model received it ${delivered} times`, delivered === 0);
    expect(delivered).toBe(0);
    await user.screenshot();
  });

  await step("the helper row offers its own Stop, so the person can stop just that helper", async () => {
    // TODO(primitive): no probe finds a control scoped to one helper row.
    const helperStop = await probe.eval(() => [...document.querySelectorAll<HTMLElement>("[data-subagent-run] button, [data-subagent-run] [role=button]")]
      .some((button) => /stop/i.test(button.getAttribute("aria-label") ?? button.textContent ?? "")));
    evidence.recordAssertionEvidence("Each helper can be stopped on its own", helperStop ? "the helper row has a Stop control" : "no Stop control on the helper row", helperStop);
    expect.soft(helperStop, "a Stop control on the helper row").toBe(true);
  });

  await step("they stop just the helper, and the turn keeps going", async () => {
    await user.click({ role: "button", label: /Check the error log\. Stop sub-agent/ });
    const helperStopped = await probe.eventually(async () =>
      (await probe.dom('[data-subagent-run]')).elements.some(element => /Stopped/.test(element.text)),
      { within: 30_000, intervalMs: 250, label: "helper Stop is acknowledged on its visible row", until: Boolean });
    const turnStillRunning = (await probe.dom('button[aria-label="Stop"]')).elements.length > 0;
    evidence.recordAssertionEvidence("Stopping one helper leaves the turn running", `helper stopped: ${helperStopped}; the turn's Stop is still offered: ${turnStillRunning}`, helperStopped && turnStillRunning);
    expect(helperStopped).toBe(true);
    expect(turnStillRunning).toBe(true);
    const helperText = (await probe.dom("[data-subagent-run]")).elements.map((element) => element.text).join(" ");
    evidence.recordAssertionEvidence("A stopped helper says Stopped, not error", `helper row reads "${helperText.slice(0, 100)}"`, /Stopped/.test(helperText) && !/reported an error/i.test(helperText));
    expect(helperText).toMatch(/Stopped/);
    expect(helperText).not.toMatch(/reported an error/i);
    await user.screenshot();
  });

  await step("after: they press Stop, and the whole turn stops", async () => {
    await user.click("Stop");
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /Working\s*\d/ }, { timeoutMs: 15_000 });
    evidence.recordAssertionEvidence("Stop ends the turn and its helper", "composer shows Run task; no Working line left", true);
    await user.screenshot();
  });

  await step("the words they queued are still there to send or edit", async () => {
    const kept = await probe.eventually(async () => {
      const onScreen = (await probe.text()).includes(world.followUp);
      const inComposer = (await probe.composer()).draftText.includes(world.followUp);
      return onScreen || inComposer;
    }, { within: 5_000, intervalMs: 250, label: "queued words kept", until: Boolean }).catch(() => false);
    evidence.recordAssertionEvidence("Stop does not throw away a queued message", kept ? "the follow-up is still visible" : "the follow-up vanished after Stop", kept);
    expect.soft(kept, "queued follow-up kept after Stop").toBe(true);
    await user.screenshot();
  });

  await step("the model never receives the follow-up on its own after Stop", async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const delivered = (await world.followUpRequests()).length;
    evidence.recordAssertionEvidence("Nothing is sent behind the person's back", `4 s after Stop the model had received the follow-up ${delivered} times`, delivered === 0);
    expect(delivered).toBe(0);
  });
});

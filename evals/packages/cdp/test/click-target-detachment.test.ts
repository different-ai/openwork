import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { callFunction, evaluate } from "../src/cdp.ts";
import { clickTarget, DisabledTargetError, TargetNotFoundError } from "../src/input.ts";
import { attachSurface } from "../src/surface.ts";
import type { Surface } from "../src/surface.ts";

// Run with CHROME_BIN pointing to a Chrome for Testing binary. This is a CDP
// primitive regression, not an application journey; it needs no product imports,
// credentials, server, or persistent browser profile.
async function startChrome() {
  const binary = process.env.CHROME_BIN;
  assert.ok(binary, "Set CHROME_BIN to a Chrome for Testing executable");
  const profile = await mkdtemp(join(tmpdir(), "cdp-click-detachment-"));
  const chrome = spawn(binary, [
    "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--window-size=800,600",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(chrome, "exit");
  async function stop() {
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
    const force = setTimeout(() => {
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }, 2_000);
    force.unref();
    try {
      await exited;
    } finally {
      clearTimeout(force);
      // Chrome's child processes can finish profile writes after the main process
      // exits. Retry removal of this test-owned directory; do not swallow failure.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  try {
    const cdpUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome did not advertise CDP within 10s")), 10_000);
      let stderr = "";
      chrome.stderr.on("data", chunk => {
        stderr += String(chunk);
        const address = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
        if (!address) return;
        clearTimeout(timer);
        resolve(`http://${new URL(address).host}`);
      });
      chrome.once("error", error => { clearTimeout(timer); reject(error); });
      chrome.once("exit", () => { clearTimeout(timer); reject(new Error(`Chrome exited before CDP: ${stderr}`)); });
    });
    const surface = await attachSurface({ name: "click-detachment", kind: "chrome", hostKind: "local", cdpUrl });
    return { surface, async stop() { await surface.stop(); await stop(); } };
  } catch (error) {
    await stop();
    throw error;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Fault = "detach" | "disabled" | "hidden" | "covered" | "dispatch-error" | "activation-shift";

function inject(surface: Surface, fault: Fault) {
  const inspections: unknown[] = [];
  const input: unknown[] = [];
  const mousePoints: unknown[] = [];
  const activations: { focused: boolean; moved: boolean; center: { x: number; y: number } }[] = [];
  const dispatchError = new TargetNotFoundError("Injected lost acknowledgement after the trusted click");
  const instrumented: Surface = {
    handle: surface.handle,
    client: {
      close() {},
      async send(method, params, options) {
        if (method.startsWith("Input.")) input.push(params?.type);
        if (method === "Input.dispatchMouseEvent") mousePoints.push({ x: params?.x, y: params?.y });
        const response = await surface.client.send(method, params, options);
        if (method === "Page.bringToFront" && fault === "activation-shift") {
          assert.deepEqual(input, [], "activation must precede input dispatch");
          // Model a focus-driven layout update at the real activation reply.
          // Reactivating the already focused page is idempotent: move only once.
          activations.push(await callFunction(surface.client, (move) => {
            const button = document.querySelector("button");
            if (!button) throw new Error("Fixture button missing during activation");
            if (move) button.style.marginLeft = "240px";
            const rect = button.getBoundingClientRect();
            return {
              focused: document.hasFocus(), moved: move,
              center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
            };
          }, [activations.length === 0]));
        }
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && fault === "dispatch-error") {
          // The browser has already delivered the click. Even an error of the
          // retryable locator class must not cause an input sequence to replay.
          throw dispatchError;
        }
        if (method !== "Runtime.callFunctionOn") return response;
        assert.ok(record(response) && record(response.result) && record(response.result.value));
        const found = response.result.value;
        inspections.push(found);
        if (inspections.length === 2 && fault !== "dispatch-error" && fault !== "activation-shift") {
          assert.equal(found.visible, true);
          assert.equal(found.hitTestOk, true);
          assert.equal(found.disabled, null);
          assert.deepEqual(input, [], "fault must precede every input dispatch");
          // waitForLocated has its two stable, genuine Chrome snapshots. Mutate
          // the real DOM at the CDP reply boundary, not the locator return value.
          await callFunction(surface.client, (fault) => {
            const button = document.querySelector("button");
            if (!button) throw new Error("Fixture button missing before mutation");
            if (fault === "detach") {
              const parking = document.createElement("template");
              parking.content.append(button);
              document.body.append(parking);
            } else if (fault === "disabled") button.disabled = true;
            else if (fault === "hidden") button.style.visibility = "hidden";
            else if (fault === "covered") {
              const cover = document.createElement("div");
              cover.textContent = "Blocking overlay";
              cover.style.cssText = "position:fixed;inset:0;background:white;z-index:100";
              document.body.append(cover);
            }
          }, [fault]);
        }
        if (fault === "detach" && found.notFound === true) {
          assert.equal(inspections.length, 3, "the fresh inspection must observe the detachment");
          assert.deepEqual(input, [], "missing target must not dispatch stale coordinates");
          // A real animation frame ends the transient absence. Hold only this
          // reply until the frame, guaranteeing a missing snapshot then a live
          // replacement, regardless of host/browser scheduling. No sleeps.
          await evaluate(surface.client, () => new Promise<void>(resolve => requestAnimationFrame(() => {
            const parking = document.querySelector("template");
            const button = parking?.content.querySelector("button");
            if (!button) throw new Error("Detached fixture button missing");
            button.style.marginLeft = "240px";
            document.body.append(button);
            parking?.remove();
            document.body.dataset.reattached = "true";
            resolve();
          })));
        }
        return response;
      },
    },
  };
  return { surface: instrumented, inspections, input, mousePoints, activations, dispatchError };
}

async function clickCounts(surface: Surface) {
  return evaluate(surface.client, () => ({
    clicks: Number(document.body.dataset.clicks),
    trusted: Number(document.body.dataset.trusted),
    reattached: document.body.dataset.reattached === "true",
  }));
}

const target = { role: "button", label: "Run task" } satisfies Parameters<typeof clickTarget>[1];

describe("clickTarget pre-dispatch target detachment (real Chrome)", { concurrency: false, timeout: 20_000 }, () => {
  let chrome: Awaited<ReturnType<typeof startChrome>>;
  before(async () => { chrome = await startChrome(); });
  after(async () => { await chrome?.stop(); });
  beforeEach(async () => {
    await evaluate(chrome.surface.client, () => {
      document.body.replaceChildren();
      document.body.dataset.clicks = "0";
      document.body.dataset.trusted = "0";
      delete document.body.dataset.reattached;
      const button = document.createElement("button");
      button.textContent = "Run task";
      button.setAttribute("aria-label", "Run task");
      button.style.cssText = "width:120px;height:40px;margin-top:40px";
      button.addEventListener("click", event => {
        document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
        document.body.dataset.trusted = String(Number(document.body.dataset.trusted) + Number(event.isTrusted));
        button.remove(); // Replaying an action would now try to find a missing target.
      });
      document.body.append(button);
    });
  });

  it("reacquires a detached target before exactly one trusted click at its new geometry", async () => {
    const fixture = inject(chrome.surface, "detach");
    const outcome = await clickTarget(fixture.surface, target, { timeoutMs: 1_000 })
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    const counts = await clickCounts(chrome.surface);
    assert.equal(counts.reattached, true, "fixture must complete its bounded reattachment");
    assert.ok(record(fixture.inspections[2]) && fixture.inspections[2].notFound === true);
    assert.equal(outcome.error, undefined, `Must reacquire before dispatch; inspections=${fixture.inspections.length}, input=${JSON.stringify(fixture.input)}, clicks=${counts.clicks}, trusted=${counts.trusted}`);
    assert.ok(outcome.value && outcome.value.center.x > 240, "must use the replacement's fresh geometry");
    assert.deepEqual(fixture.input, ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.deepEqual(counts, { clicks: 1, trusted: 1, reattached: true });
  });

  it("activates before measuring and delivers one trusted click at the post-activation geometry", async () => {
    const fixture = inject(chrome.surface, "activation-shift");
    const found = await clickTarget(fixture.surface, target, { timeoutMs: 1_000 });
    assert.deepEqual(fixture.input, ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.deepEqual(await clickCounts(chrome.surface), { clicks: 1, trusted: 1, reattached: false },
      "activation moved the real target; stale pre-activation coordinates must not absorb the click");
    assert.deepEqual(fixture.activations.map(({ focused, moved }) => ({ focused, moved })), [
      { focused: true, moved: true }, { focused: true, moved: false },
    ], "clickAt must retain activation without repeating the focused page's layout change");
    const center = fixture.activations[0].center;
    assert.ok(center.x > 240, "the activation must actually move the DOM button");
    assert.deepEqual(fixture.activations[1].center, center, "second activation must be idempotent");
    assert.deepEqual(found.center, center);
    assert.deepEqual(fixture.mousePoints, [center, center, center]);
  });

  for (const fault of ["disabled", "hidden", "covered"] satisfies Fault[]) {
    it(`keeps a hard failure when the fresh target becomes ${fault}`, async () => {
      const fixture = inject(chrome.surface, fault);
      await assert.rejects(clickTarget(fixture.surface, target, { timeoutMs: 1_000 }), fault === "disabled"
        ? DisabledTargetError : /moved before the click could be dispatched/);
      assert.equal(fixture.inspections.length, 3, "do not retry disabled/hidden/covered assertions");
      assert.deepEqual(fixture.input, []);
      assert.deepEqual(await clickCounts(chrome.surface), { clicks: 0, trusted: 0, reattached: false });
    });
  }

  it("times out without dispatch when the target never appears", async () => {
    await evaluate(chrome.surface.client, () => document.querySelector("button")?.remove());
    const fixture = inject(chrome.surface, "dispatch-error");
    const started = performance.now();
    await assert.rejects(clickTarget(fixture.surface, target, { timeoutMs: 80 }), /Timed out after 80ms locating target/);
    assert.ok(performance.now() - started < 1_000, "absence must honor the bounded timeout");
    assert.deepEqual(fixture.input, []);
  });

  it("does not retry a locator-class error after a trusted click was dispatched", async () => {
    const fixture = inject(chrome.surface, "dispatch-error");
    await assert.rejects(clickTarget(fixture.surface, target, { timeoutMs: 1_000 }), error => error === fixture.dispatchError);
    assert.equal(fixture.inspections.length, 3, "no reacquisition after dispatch");
    assert.deepEqual(fixture.input, ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.deepEqual(await clickCounts(chrome.surface), { clicks: 1, trusted: 1, reattached: false });
  });
});

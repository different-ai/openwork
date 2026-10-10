import { browserScript, evaluate, setViewport } from "@openwork/cdp";
import { checkContrast, checkOverlap, collectLayout, LAYOUT_BOX_LIMIT, parseLayoutSnapshot } from "@openwork/design-review";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/**
 * An instrumentation fixture, not a substitute audit-log UI. P3/S3 native
 * disclosures and a split inline paragraph reproduce the proven collector
 * defects. The final controls intentionally violate contrast/overlap rules:
 * they are negative witnesses, not relaxed product design requirements.
 */
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Visible content review</title><style>
:root{--background:#fcfcfd;--text:#1c2024;--muted:#60646c;--border:#e8e8ec;--faint:#cdd0d6}
body{margin:0;background:var(--background);color:var(--text);font:13px/20px Arial,sans-serif}
main{width:720px;padding:32px 40px}h1{font-size:20px;line-height:28px;margin:0 0 16px;font-weight:600}
h2{font-size:13px;line-height:20px;margin:0 0 12px;font-weight:600}section{padding:16px 0;border-bottom:1px solid var(--border)}
button{font:inherit;color:var(--text);background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px 12px;cursor:pointer}
button:focus-visible,summary:focus-visible{outline:2px solid var(--muted);outline-offset:3px}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted)}dl{display:grid;grid-template-columns:80px 1fr;gap:8px 20px;margin:12px 0}
dt,dd{margin:0}dd{font-family:monospace}details details{margin:12px 0}
[data-testid="wrapped-paragraph"]{width:600px;font:16px/24px monospace;margin:0}
[data-testid="problem-controls"]{padding-top:16px}.overlap{position:relative;width:600px;height:48px}
.overlap span{position:absolute;pointer-events:none}.overlap .first{left:0;top:4px}.overlap .second{left:12px;top:8px}
.faint{color:var(--faint);margin:12px 0}button:disabled{color:var(--faint);cursor:default}[hidden]:not([hidden="until-found"]){display:none!important}
</style></head><body><main>
<h1>Visible content review</h1>
<section>
<button id="toggle-details" aria-controls="technical-details" aria-expanded="false">Open technical details</button>
<details id="technical-details" data-testid="technical-details">
<summary><span data-testid="technical-summary">Technical details</span></summary>
<dl><dt>Event</dt><dd data-testid="technical-event" data-technical-value>event_fixture_001</dd><dt>Request</dt><dd data-testid="technical-request" data-technical-value>request_fixture_002</dd></dl>
<details><summary data-testid="operation-summary">Operation identifiers</summary><p data-testid="operation-id">operation_fixture_003</p></details>
</details>
</section>
<section><h2>Capacity</h2>
<p data-testid="wrapped-paragraph">Read-only capacity policy.<!-- distinct inline node --> Billing is disabled.<!-- distinct inline node --> Usage stays available for this organization, including recorded operations, request history, and the current capacity policy.</p>
</section>
<section>
<button id="toggle-problems" aria-controls="problem-controls" aria-expanded="false">Show problem controls</button>
<div id="problem-controls" data-testid="problem-controls" hidden>
<h2>Problem controls</h2>
<div class="overlap"><span class="first" data-testid="overlap-first">First overlapping line</span><span class="second" data-testid="overlap-second">Second overlapping line</span></div>
<p class="faint" data-testid="faint-text">Faint text remains a design defect</p>
<button disabled data-testid="disabled-faint">Locked control</button>
</div>
</section>
<div style="content-visibility:hidden;height:0"><p data-testid="unpainted-content">content_visibility_fixture_004</p></div>
<div hidden="until-found"><p data-testid="until-found-content">until_found_fixture_005</p></div>
<output id="trusted-actions" hidden></output>
</main><script>
const actions = document.getElementById("trusted-actions");
const record = (event) => { actions.dataset.clicks = [actions.dataset.clicks, String(event.isTrusted)].filter(Boolean).join(","); };
const details = document.getElementById("technical-details");
const detailsButton = document.getElementById("toggle-details");
detailsButton.addEventListener("click", (event) => {
  record(event);
  details.open = !details.open;
  detailsButton.setAttribute("aria-expanded", String(details.open));
  detailsButton.textContent = details.open ? "Close technical details" : "Open technical details";
});
const problems = document.getElementById("problem-controls");
const problemsButton = document.getElementById("toggle-problems");
problemsButton.addEventListener("click", (event) => {
  record(event);
  problems.hidden = !problems.hidden;
  problemsButton.setAttribute("aria-expanded", String(!problems.hidden));
  problemsButton.textContent = problems.hidden ? "Show problem controls" : "Hide problem controls";
});
</script></body></html>`;

export async function designLayoutVisibleContentWorld(_seed: Seed, { place }: { place: Place }) {
  const app = await chrome({ name: "design-layout-visible-content", host: place.host(), startUrl: "about:blank", headless: true });
  try {
    await setViewport(app, { width: 1100, height: 900, deviceScaleFactor: 1 });
    return {
      app,
      url: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`,
      async measure() {
        // Justified infrastructure observation: run the actual self-contained
        // collector over CDP exactly as screenshot sidecars do. This reads the
        // page; fixture state changes only through trusted user.click buttons.
        const layout = parseLayoutSnapshot(await evaluate(app.client, browserScript(collectLayout, [LAYOUT_BOX_LIMIT])));
        if (!layout) throw new Error("The visible-content fixture did not report its layout.");
        const witness = await evaluate(app.client, () => {
          const project = (rect: DOMRect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          const details = document.getElementById("technical-details");
          const paragraph = document.querySelector('[data-testid="wrapped-paragraph"]');
          const paragraphNodes = Array.from(paragraph?.childNodes ?? []).filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
          return {
            detailsOpen: details instanceof HTMLDetailsElement && details.open,
            cachedDetails: Array.from(document.querySelectorAll("[data-technical-value]")).map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return { text: element.textContent ?? "", painted: element.checkVisibility({ contentVisibilityAuto: true }), rect: project(range.getBoundingClientRect()) };
            }),
            paragraphNodes: paragraphNodes.map((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return { text: (node.textContent ?? "").trim(), union: project(range.getBoundingClientRect()), fragments: Array.from(range.getClientRects()).map(project) };
            }),
            trustedClicks: (document.getElementById("trusted-actions")?.dataset.clicks ?? "").split(",").filter(Boolean),
          };
        });
        return { layout, overlaps: checkOverlap(layout), contrast: checkContrast(layout), witness };
      },
      async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await app[Symbol.asyncDispose]();
    throw error;
  }
}

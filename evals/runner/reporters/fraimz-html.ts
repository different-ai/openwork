import type { EvalMode, EvalReport, Evidence, FlowKind } from "../flow.ts";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function flowKindBadge(kind: FlowKind | null): string {
  if (kind === "user-facing") return `<span class="kind kind-user">User-facing flow demo</span>`;
  if (kind === "internal") return `<span class="kind kind-internal">Internal demo</span>`;
  return `<span class="kind kind-legacy">Legacy flow — no demo kind declared</span>`;
}

export function renderFrameIndex(report: EvalReport): string {
  const soakSection = renderSoakSection(report);
  const flowSections = report.flows.map((flow) => {
    const steps = (flow.steps ?? []).map((step) => `
        <article class="step ${step.status === "passed" ? "passed" : "failed"}">
          <header>
            <div class="eyebrow">${escapeHtml(step.status.toUpperCase())} · ${Number(step.durationMs) || 0}ms</div>
            <h3>${escapeHtml(step.name)}</h3>
            ${step.error ? `<div class="error">${escapeHtml(step.error)}</div>` : ""}
          </header>
          ${renderEvidence(step.evidence ?? [], report.mode)}
        </article>`).join("\n");
    return `
      <section data-flow="${escapeHtml(flow.id)}">
        <h2>${escapeHtml(flow.id)} - ${escapeHtml(flow.title)}</h2>
        <p>${flowKindBadge(flow.kind)} <button type="button" class="speak-all" data-flow-id="${escapeHtml(flow.id)}">▶ Play full voiceover</button></p>
        ${flow.spec ? `<p class="muted">Spec: ${escapeHtml(flow.spec)}</p>` : ""}
        ${flow.skipReason ? `<p class="skipped">Skipped: ${escapeHtml(flow.skipReason)}</p>` : ""}
        <div class="steps">${steps}</div>
      </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>fraimz · OpenWork Eval Run ${escapeHtml(report.runId)}</title>
  <style>
    body { margin: 0; background: #f7f7f8; color: #171717; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin-top: 32px; }
    h3 { margin: 2px 0 10px; font-size: 18px; }
    .meta, .muted { color: #5f6368; }
    .summary { display: inline-flex; gap: 12px; margin: 16px 0 8px; padding: 10px 12px; border: 1px solid #ddd; border-radius: 10px; background: white; }
    .steps { display: grid; gap: 18px; margin-top: 16px; }
    .step { padding: 16px; border: 1px solid #ddd; border-radius: 14px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
    .step.failed { border-color: #f4b4ae; background: #fff8f7; }
    .eyebrow { color: #5f6368; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .evidence { display: grid; gap: 12px; }
    .claim { padding: 10px 12px; border-left: 4px solid #7c3aed; background: #f5f3ff; border-radius: 8px; }
    .voiceover { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-left: 4px solid #0e7490; background: #ecfeff; border-radius: 8px; font-style: italic; }
    .voiceover-missing { padding: 8px 12px; border-left: 4px solid #d97706; background: #fffbeb; border-radius: 8px; color: #92400e; font-size: 13px; }
    .speak, .speak-all { flex-shrink: 0; border: 1px solid #0e7490; border-radius: 999px; background: white; color: #0e7490; font-size: 12px; padding: 3px 10px; cursor: pointer; }
    .speak:hover, .speak-all:hover { background: #cffafe; }
    .kind { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .kind-user { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .kind-internal { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .kind-legacy { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
    .surface-chip { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 700; }
    .assertions, .validations { margin: 8px 0 0; padding-left: 20px; }
    .assertions li, .validations li { margin: 5px 0; }
    figure { margin: 0; overflow: hidden; border: 1px solid #ddd; border-radius: 12px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    img { display: block; width: 100%; height: auto; }
    figcaption { padding: 10px 12px; border-top: 1px solid #eee; font-size: 13px; color: #444; }
    li { margin: 8px 0; }
    .passed-text { color: #0a7f35; font-weight: 700; }
    .failed-text, .error { color: #b42318; font-weight: 700; }
    .skipped { color: #8a5a00; }
    code { background: #ededf0; padding: 2px 5px; border-radius: 5px; }
    pre.output { margin: 0; padding: 12px; background: #16181d; color: #d6e2f0; font-size: 12.5px; line-height: 1.5; overflow-x: auto; border-radius: 0 0 12px 12px; }
  </style>
</head>
<body>
  <main>
    <h1>fraimz</h1>
    <p class="muted">Frame-by-frame proof of the flow, as the end user experienced it.</p>
    <div class="meta">
      Run ID: <code>${escapeHtml(report.runId)}</code><br />
      Mode: <code>${escapeHtml(report.mode)}</code><br />
      Started: ${escapeHtml(report.startedAt)}<br />
      Finished: ${escapeHtml(report.finishedAt ?? "") }<br />
      CDP: <code>${escapeHtml(report.cdpUrl)}</code>
    </div>
    <div class="summary">
      <span>Passed: ${report.summary.passed}</span>
      <span>Failed: ${report.summary.failed}</span>
      <span>Skipped: ${report.summary.skipped}</span>
    </div>
    ${soakSection}${flowSections}
  </main>
  <script>
    (function () {
      if (!("speechSynthesis" in window)) return;
      var speak = function (texts) {
        window.speechSynthesis.cancel();
        texts.forEach(function (text) {
          var utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.05;
          window.speechSynthesis.speak(utterance);
        });
      };
      document.querySelectorAll(".voiceover .speak").forEach(function (button) {
        button.addEventListener("click", function () {
          var host = button.closest(".voiceover");
          if (host) speak([host.getAttribute("data-voiceover") || ""]);
        });
      });
      document.querySelectorAll(".speak-all").forEach(function (button) {
        button.addEventListener("click", function () {
          var section = button.closest("section");
          if (!section) return;
          var texts = Array.prototype.map.call(
            section.querySelectorAll(".voiceover[data-voiceover]"),
            function (node) { return node.getAttribute("data-voiceover"); }
          ).filter(Boolean);
          speak(texts);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderSoakSection(report: EvalReport): string {
  if (!report.soak?.length) return "";
  const rows = report.soak.map((soak) => `<tr>
        <td><code>${escapeHtml(soak.flowId)}</code></td>
        <td>${soak.repeat}</td>
        <td>${soak.passed}</td>
        <td>${soak.failed}</td>
        <td>${soak.skipped}</td>
        <td>${escapeHtml(soak.capturedIterations.join(", ") || "none")}</td>
        <td>${escapeHtml(soak.status)}</td>
      </tr>`).join("\n");
  return `<section>
      <h2>Soak summary</h2>
      <table style="width: 100%; border-collapse: collapse; background: white; border: 1px solid #ddd; border-radius: 12px; overflow: hidden;">
        <thead><tr><th>Flow</th><th>Repeat</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Captured iterations</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    `;
}

function renderEvidence(evidence: Evidence[], mode: EvalMode): string {
  if (evidence.length === 0) return `<p class="muted">No structured evidence recorded for this step.</p>`;
  return `<div class="evidence">${evidence.map((item) => {
    if (item.type === "claim") {
      // App-less frames (requiresApp: false) have no screenshot figure, so the
      // completed claim carries the narration instead.
      const voiceover = item.status === "passed" && item.voiceover
        ? `<div class="voiceover" data-voiceover="${escapeHtml(item.voiceover)}"><button type="button" class="speak" title="Play voiceover">🎙 Play</button><span>${escapeHtml(item.voiceover)}</span></div>`
        : "";
      return `<div class="claim"><strong>${escapeHtml(item.name ?? "Claim")}</strong><br />${escapeHtml(item.claim ?? "")}</div>${voiceover}`;
    }
    if (item.type === "output") {
      return `<figure><figcaption><strong>${escapeHtml(item.name ?? "Output")}</strong></figcaption><pre class="output">${escapeHtml(item.text ?? "")}</pre></figure>`;
    }
    if (item.type === "assertion") {
      const cls = item.status === "passed" ? "passed-text" : "failed-text";
      return `<div><span class="${cls}">${escapeHtml(item.status ?? "unknown")}</span> ${escapeHtml(item.assertion ?? "Assertion")}${item.actual ? `<br /><span class="muted">Actual: ${escapeHtml(item.actual)}</span>` : ""}</div>`;
    }
    if (item.type === "frame") {
      const validations = (item.validations ?? []).map((validation) => {
        const cls = validation.passed ? "passed-text" : "failed-text";
        return `<li><span class="${cls}">${validation.passed ? "PASS" : "FAIL"}</span> ${escapeHtml(validation.label)}${validation.detail ? ` <span class="muted">${escapeHtml(validation.detail)}</span>` : ""}</li>`;
      }).join("\n");
      const voiceover = item.voiceover
        ? `<div class="voiceover" data-voiceover="${escapeHtml(item.voiceover)}"><button type="button" class="speak" title="Play voiceover">🎙 Play</button><span>${escapeHtml(item.voiceover)}</span></div>`
        : mode === "demo"
          ? `<div class="voiceover-missing">No voiceover for this frame. Every fraimz frame should narrate what the user sees.</div>`
          : "";
      const surface = item.surface ? `<span class="surface-chip">Surface: ${escapeHtml(item.surface)}</span>` : "";
      return `<figure>
        ${voiceover}
        <a href="${escapeHtml(item.file)}"><img src="${escapeHtml(item.file)}" alt="${escapeHtml(item.claim ?? item.name ?? item.file)}" /></a>
        <figcaption>
          <strong>${escapeHtml(item.name ?? item.file)}</strong>${surface}${item.claim ? `<br />Claim: ${escapeHtml(item.claim)}` : ""}
          ${item.url ? `<br /><span class="muted">URL: ${escapeHtml(item.url)}</span>` : ""}
          <ul class="validations">${validations}</ul>
        </figcaption>
      </figure>`;
    }
    return `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`;
  }).join("\n")}</div>`;
}

"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";
import { EvidenceViewer } from "./evidence-viewer";
import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";
import { LaunchPreview } from "./launch-preview";
import { CheckpointProvider } from "./open-checkpoint";
import { StatusIcon } from "./status-icon";

type Verdict = ReturnType<typeof summarizeReview>["verdict"];

/** One sentence of state per verdict: what is true, and where to look first (P1, C6). */
function verdictLine(verdict: Verdict, failedSections: number, incompleteSections: number, gaps: number) {
  if (verdict === "Failed") return `${failedSections} ${failedSections === 1 ? "section has" : "sections have"} a failing check. Start there.`;
  if (verdict === "Incomplete") {
    const parts = [
      incompleteSections > 0 ? `${incompleteSections} ${incompleteSections === 1 ? "section is" : "sections are"} missing evidence or waiting for a judgment` : "",
      gaps > 0 ? `${gaps} declared ${gaps === 1 ? "gap" : "gaps"}` : "",
    ].filter(Boolean);
    return `Nothing failed, but ${parts.join(" and ") || "some evidence is still pending"}.`;
  }
  if (verdict === "Reference") return "Reference images only. Nothing here was tested.";
  return "Every recorded check passed.";
}

export function Judgments({ items }: { items: ReviewEvidence["judgments"] }) {
  return (
    <ul className="assertions">
      {items.map((item, index) => (
        <li key={index} className={item.state}>
          <StatusIcon state={item.state} />
          <div>
            <strong>{item.expectation}</strong>
            {item.reasoning && <p>{item.reasoning}</p>}
          </div>
          {item.state !== "passed" && <span className={`result ${item.state}`}>{item.state}</span>}
        </li>
      ))}
    </ul>
  );
}

export function Report({ report, id, connected }: { report: ReviewReport; id: string; connected: boolean }) {
  const [filter, setFilter] = useState("All");
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const summary = summarizeReview(report);
  const assetUrl = (name: string) => `/r/${id}/assets/${name}`;
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  const sections = report.sections.flatMap((section) => {
    const source = report.sources.find((item) => item.id === section.sourceId);
    if (!source) return [];
    const items = section.evidenceIds.flatMap((key) => evidenceById.get(key) ?? []);
    return [{ ...section, source, items, verdict: summarizeReview({ sources: [source], evidence: items, gaps: [] }).verdict }];
  });
  const visibleSections = sections.filter((section) => filter === "All" || section.verdict === filter);
  const failures = sections.filter((section) => section.verdict === "Failed");
  const incompletes = sections.filter((section) => section.verdict === "Incomplete");
  function nextFailure() {
    setFilter("All");
    const current = failures.findIndex((section) => `#${section.id}` === window.location.hash);
    const next = failures[(current + 1) % failures.length];
    if (next) requestAnimationFrame(() => {
      window.location.hash = next.id;
      document.getElementById(next.id)?.focus();
    });
  }
  const created = new Date(report.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  return (
    <CheckpointProvider><main className={`report${sandboxOpen ? " sandbox-open" : ""}`}>
      <div className="intro">
        <div className="report-toolbar">
          <code title={report.gitSha}>{report.gitSha.slice(0, 7)}</code>
          <CopyButton label="Copy commit" value={report.gitSha} />
          <time dateTime={report.createdAt} className="scope">{created} UTC</time>
          <button type="button" aria-expanded={sandboxOpen} aria-controls="sandbox-panel" onClick={() => setSandboxOpen(!sandboxOpen)}>{sandboxOpen ? "Hide sandbox" : "Show sandbox"}</button>
        </div>
        <h1>{report.title}</h1>
        <div className={`verdict ${summary.verdict.toLowerCase()}`} role="status">
          <StatusIcon state={summary.verdict} size={20} />
          <div>
            <strong className={`badge ${summary.verdict.toLowerCase()}`} title="The result of the evidence selected for this report, not a merge approval.">
              Selected evidence: {summary.verdict}
            </strong>
            <p>{verdictLine(summary.verdict, failures.length, incompletes.length, report.gaps.length)}</p>
          </div>
          <dl className="summary">
            {summary.tests > 0 && <div><dt>Tests</dt><dd>{summary.passedTests}/{summary.tests}</dd></div>}
            {summary.assertions > 0 && <div><dt>Checks</dt><dd>{summary.passedAssertions}/{summary.assertions}</dd></div>}
            <div><dt>Screenshots</dt><dd>{summary.images}</dd></div>
          </dl>
        </div>
        {(report.gaps.length > 0 || summary.pendingVisual > 0) && (
          <aside className="gaps">
            <strong>Still to verify</strong>
            <ul>
              {report.gaps.map((gap, index) => (
                <li key={index}>{gap}</li>
              ))}
              {summary.pendingVisual > 0 && (
                <li>{`${summary.pendingVisual} visual ${summary.pendingVisual === 1 ? "judgment" : "judgments"} pending.`}</li>
              )}
            </ul>
          </aside>
        )}
      </div>
      <aside id="sandbox-panel" className="sandbox-sidebar" aria-label="Your sandbox" hidden={!sandboxOpen}>
        <LaunchPreview id={id} connected={connected} />
      </aside>
      <div className="report-body">
        <div className="filter-bar" aria-label="Filter evidence">
          {["All", "Failed", "Incomplete"].map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value} ({value === "All" ? sections.length : sections.filter((section) => section.verdict === value).length})</button>)}
          <button type="button" className="quiet" disabled={!failures.length} onClick={nextFailure}>Next failure</button>
          <span role="status">{visibleSections.length} of {sections.length} sections</span>
        </div>
        <label className="section-picker">Jump to section
          <select aria-label="Jump to section" value="" onChange={(event) => { window.location.hash = event.target.value; document.getElementById(event.target.value)?.focus(); }}>
            <option value="" disabled>Choose a section</option>
            {visibleSections.map((section) => <option key={section.id} value={section.id}>{section.title} — {section.verdict}</option>)}
          </select>
        </label>
        <nav className="contents" aria-label="Report sections">
          {visibleSections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={section.verdict.toLowerCase()}>
              <StatusIcon state={section.verdict} />
              <span className="nav-title">{section.title}<span className="visually-hidden"> — {section.verdict}</span></span>
            </a>
          ))}
          <a className="download" href={assetUrl("report.json")}>
            Download report
          </a>
        </nav>
        <div className="sections">
          {visibleSections.length === 0 && <p className="empty">No {filter.toLowerCase()} sections. <button type="button" onClick={() => setFilter("All")}>Show all evidence</button></p>}
          {visibleSections.map((section) => {
            const { source, items, verdict } = section;
            const assertions = items
              .filter((item) => item.kind === "assertion")
              .flatMap((item) => item.judgments);
            const passed = assertions.filter((item) => item.state === "passed").length;
            const images = items.filter((item) => item.kind === "image");
            return (
              <section className={`section ${verdict.toLowerCase()}`} id={section.id} key={section.id} tabIndex={-1}>
                <div className="section-heading">
                  <StatusIcon state={verdict} size={18} />
                  <div>
                    <h2>{section.title}</h2>
                    {source.kind === "docshot" && <p className="eyebrow">Documentation reference</p>}
                  </div>
                  <span className={`result ${verdict.toLowerCase()}`}>{verdict}</span>
                </div>
                {source.kind === "test-run" && source.outcome !== "passed" && (
                  <p className="outcome">
                    Execution {source.outcome}
                    {source.failure ? `: ${source.failure}` : ""}
                  </p>
                )}
                {assertions.length > 0 && (
                  <details className="checks" open={assertions.some((item) => item.state !== "passed")}>
                    <summary>
                      {passed} of {assertions.length} {assertions.length === 1 ? "check" : "checks"} passed
                    </summary>
                    <Judgments items={assertions} />
                  </details>
                )}
                {source.kind === "test-run" && assertions.length === 0 && (
                  <p className="outcome">
                    No assertion evidence was recorded for this run.
                  </p>
                )}
                {images.length > 0 && <ol className="gallery" aria-label="Screenshots">
                  {images.map((item, index) => (
                    <li key={item.id}>
                      <figure>
                        <a className="image-link" href={`#evidence-${item.id}`} aria-label={`Inspect ${item.caption}`}>
                          <img src={assetUrl(item.asset)} alt={item.caption} loading="lazy" />
                          {item.checkpoint && <span className="saved-browser" title="Open the screenshot to enter a private copy of this browser.">Saved browser</span>}
                        </a>
                        <figcaption>
                          <span className="step-number">{index + 1}</span>
                          <div>
                            <strong>{item.caption}</strong>
                            {item.description && <p>{item.description}</p>}
                            {item.judgments.length > 0 && (
                              <p className={item.judgments.some((judgment) => judgment.state === "failed") ? "result failed" : item.judgments.some((judgment) => judgment.state === "pending") ? "result pending" : "visual-passed"}>
                                Visual checks {item.judgments.filter((judgment) => judgment.state === "passed").length}/{item.judgments.length} passed
                              </p>
                            )}
                          </div>
                        </figcaption>
                      </figure>
                    </li>
                  ))}
                </ol>}
                <details className="provenance">
                  <summary>Source and diagnostics</summary>
                  <div className="source-row">
                    {source.name !== section.title && <span>{source.name}</span>}
                    <code title={source.gitSha}>{source.gitSha.slice(0, 7)}</code>
                    <span>Captured {new Date(source.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</span>
                    <CopyButton label="Copy section link" value={`#${section.id}`} link />
                    <a href={assetUrl(source.asset)} target="_blank" rel="noreferrer">{source.kind === "test-run" ? "View record and trace" : "View receipt"}</a>
                  </div>
                </details>
              </section>
            );
          })}
        </div>
      </div>
      <EvidenceViewer report={report} id={id} connected={connected} />
      <footer>
        Recorded evidence. Discussion and approval stay on the pull request.
      </footer>
    </main></CheckpointProvider>
  );
}

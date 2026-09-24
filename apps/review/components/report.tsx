"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";
import { EvidenceViewer } from "./evidence-viewer";
import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";
import { LaunchPreview } from "./launch-preview";

export function Judgments({ items }: { items: ReviewEvidence["judgments"] }) {
  return (
    <ul className="assertions">
      {items.map((item, index) => (
        <li key={index}>
          <span className={`dot ${item.state}`} aria-label={item.state} />
          <div>
            <strong>{item.expectation}</strong>
            <p>{item.reasoning}</p>
          </div>
          <span className={`result ${item.state}`}>{item.state}</span>
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
    return [{ ...section, verdict: summarizeReview({ sources: [source], evidence: items, gaps: [] }).verdict }];
  });
  const visibleSections = sections.filter((section) => filter === "All" || section.verdict === filter);
  const failures = sections.filter((section) => section.verdict === "Failed");
  function nextFailure() {
    setFilter("All");
    const current = failures.findIndex((section) => `#${section.id}` === window.location.hash);
    const next = failures[(current + 1) % failures.length];
    if (next) requestAnimationFrame(() => {
      window.location.hash = next.id;
      document.getElementById(next.id)?.focus();
    });
  }
  return (
    <main className={`report${sandboxOpen ? " sandbox-open" : ""}`}>
      <div className="intro">
        <div className="report-toolbar">
          <code title={report.gitSha}>{report.gitSha.slice(0, 7)}</code>
          <CopyButton label="Copy commit" value={report.gitSha} />
          <button type="button" aria-expanded={sandboxOpen} aria-controls="sandbox-panel" onClick={() => setSandboxOpen(!sandboxOpen)}>{sandboxOpen ? "Hide sandbox" : "Show sandbox"}</button>
        </div>
        <h1>{report.title}</h1>
        <div className="summary">
          <span className={`badge ${summary.verdict.toLowerCase()}`}>
            Selected evidence: {summary.verdict}
          </span>
          {summary.tests > 0 && (
            <span>
              {summary.passedTests} of {summary.tests} tests passed
            </span>
          )}
          {summary.assertions > 0 && (
            <span>
              {summary.passedAssertions} of {summary.assertions} assertions
              passed
            </span>
          )}
          <span>{summary.images} images</span>
        </div>
        <p className="scope">
          <time dateTime={report.createdAt}>
            {new Date(report.createdAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "UTC",
            })}{" "}
            UTC
          </time>
        </p>
        {(report.gaps.length > 0 || summary.pendingVisual > 0) && (
          <aside className="gaps">
            <strong>Still to verify</strong>
            <ul>
              {report.gaps.map((gap, index) => (
                <li key={index}>{gap}</li>
              ))}
              {summary.pendingVisual > 0 && (
                <li>{summary.pendingVisual} visual judgment(s) pending.</li>
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
          {['All', 'Failed', 'Incomplete'].map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value} ({value === 'All' ? sections.length : sections.filter((section) => section.verdict === value).length})</button>)}
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
          <p className="eyebrow">In this review</p>
          {visibleSections.map((section, index) => (
            <a key={section.id} href={`#${section.id}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span className="nav-title">{section.title}<small className={`result ${section.verdict.toLowerCase()}`}>{section.verdict}</small></span>
            </a>
          ))}
          <a className="download" href={assetUrl("report.json")}>
            Download report
          </a>
        </nav>
        <div className="sections">
          {visibleSections.length === 0 && <p className="empty">No {filter.toLowerCase()} sections. <button type="button" onClick={() => setFilter("All")}>Show all evidence</button></p>}
          {visibleSections.map((section, index) => {
            const source = report.sources.find(
              (item) => item.id === section.sourceId,
            );
            if (!source) return null;
            const items = section.evidenceIds.flatMap((key) => {
              const item = evidenceById.get(key);
              return item ? [item] : [];
            });
            const assertions = items
              .filter((item) => item.kind === "assertion")
              .flatMap((item) => item.judgments);
            const verdict = summarizeReview({
              sources: [source],
              evidence: items,
              gaps: [],
            }).verdict;
            return (
              <section className="section" id={section.id} key={section.id} tabIndex={-1}>
                <div className="section-heading">
                  <span className="number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="eyebrow">
                      {source.kind === "docshot"
                        ? "Documentation reference"
                        : "Test run"}
                    </p>
                    <h2>{section.title}</h2>
                  </div>
                  <span className={`result ${verdict.toLowerCase()}`}>
                    {verdict}
                  </span>
                </div>
                <div className="source-row">
                  {source.name !== section.title && <span>{source.name}</span>}
                  <code title={source.gitSha}>{source.gitSha.slice(0, 7)}</code>
                  <CopyButton label="Copy section link" value={`#${section.id}`} link />
                  <a href={assetUrl(source.asset)} target="_blank" rel="noreferrer">{source.kind === "test-run" ? "View record and trace" : "View receipt"}</a>
                </div>
                {source.kind === "test-run" && source.outcome !== "passed" && (
                  <p className="empty">
                    Execution {source.outcome}
                    {source.failure ? `: ${source.failure}` : ""}
                  </p>
                )}
                {assertions.length > 0 && (
                  <details
                    className="checks"
                    open={assertions.some((item) => item.state !== "passed")}
                  >
                    <summary>
                      {assertions.length} recorded assertion
                      {assertions.length === 1 ? "" : "s"}
                      <span>Inspect results</span>
                    </summary>
                    <Judgments items={assertions} />
                  </details>
                )}
                {source.kind === "test-run" && assertions.length === 0 && (
                  <p className="empty">
                    No assertion evidence was recorded for this run.
                  </p>
                )}
                {items
                  .filter((item) => item.kind === "image")
                  .map((item) => (
                    <figure key={item.id}>
                      <a
                        className="image-link"
                        href={`#evidence-${item.id}`}
                        aria-label={`Inspect ${item.caption}`}
                      >
                        <img
                          src={assetUrl(item.asset)}
                          alt={item.caption}
                          loading="lazy"
                        />
                      </a>
                      <figcaption>
                        <strong>{item.caption}</strong>
                        <CopyButton label="Copy image link" value={`#evidence-${item.id}`} link />
                        {item.description && <p>{item.description}</p>}
                      </figcaption>
                      {item.judgments.length > 0 && (
                        <details
                          className="visual"
                          open={item.judgments.some(
                            (judgment) => judgment.state !== "passed",
                          )}
                        >
                          <summary>
                            Visual checks ·{" "}
                            {
                              item.judgments.filter(
                                (judgment) => judgment.state === "passed",
                              ).length
                            }
                            /{item.judgments.length} passed
                          </summary>
                          <Judgments items={item.judgments} />
                        </details>
                      )}
                    </figure>
                  ))}
                <details className="provenance">
                  <summary>Source and diagnostics</summary>
                  <p>
                    Commit <code>{source.gitSha}</code>
                  </p>
                  <p>Captured {source.createdAt}</p>
                  <a href={assetUrl(source.asset)}>
                    Open original{" "}
                    {source.kind === "test-run"
                      ? "test record, steps, and trace"
                      : "DocShot receipt"}{" "}

                  </a>
                </details>
              </section>
            );
          })}
        </div>
      </div>
      <EvidenceViewer report={report} id={id} connected={connected} />
      <footer>
        Recorded evidence · Human discussion and approval remain on the pull
        request.
      </footer>
    </main>
  );
}

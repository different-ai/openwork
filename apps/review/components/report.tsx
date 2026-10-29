"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";
import { EvidenceMap } from "./evidence-map";
import { EvidenceViewer } from "./evidence-viewer";
import { Icon } from "./icons";
import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";
import { LaunchPreview } from "./launch-preview";
import { MarkedShot } from "./marked-shot";
import { CheckpointProvider } from "./open-checkpoint";
import { StatusIcon } from "./status-icon";
import type { PreviewProviderOption } from "../lib/preview-options";
import { composeSections, designNotesLabel, visualState, type Verdict } from "../lib/sections";
import { closesStep, describeChange, isRepeat, stepChecks, stepFound } from "../lib/change";

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

const formatUtc = (value: string) => new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function Report({ report, id, connected, providerLabel, checkpointProviders, previewProviders }: {
  report: ReviewReport; id: string; connected: boolean;
  /** The provider new previews launch on, e.g. "Freestyle". */
  providerLabel: string;
  previewProviders?: readonly PreviewProviderOption[];
  /** Providers whose saved checkpoints this server can open. */
  checkpointProviders: readonly string[];
}) {
  const [filter, setFilter] = useState("All");
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const summary = summarizeReview(report);
  const assetUrl = (name: string) => `/r/${id}/assets/${name}`;
  const sections = composeSections(report);
  const visibleSections = sections.filter((section) => filter === "All" || section.verdict === filter);
  const failures = sections.filter((section) => section.verdict === "Failed");
  const incompletes = sections.filter((section) => section.verdict === "Incomplete");
  /** Clears the filter so the target exists, then scrolls to and focuses it. */
  function jumpTo(sectionId: string) {
    setFilter("All");
    requestAnimationFrame(() => {
      window.location.hash = sectionId;
      document.getElementById(sectionId)?.focus();
    });
  }
  function nextFailure() {
    const current = failures.findIndex((section) => `#${section.id}` === window.location.hash);
    const next = failures[(current + 1) % failures.length];
    if (next) jumpTo(next.id);
    else setFilter("All");
  }
  const verdictKey = summary.verdict.toLowerCase();
  return (
    <CheckpointProvider><main className={`report${sandboxOpen ? " sandbox-open" : ""}`}>
      <header className="intro">
        <div className="hero">
          <div className="hero-text">
            <p className="eyebrow"><Icon name="fileText" size={14} />Evidence report</p>
            <h1>{report.title}</h1>
            <div className="report-toolbar">
              <span className="tag commit"><Icon name="commit" size={13} /><code title={report.gitSha}>{report.gitSha.slice(0, 7)}</code></span>
              <CopyButton label="Copy commit" value={report.gitSha} />
              <span className="tag"><Icon name="clock" size={13} /><time dateTime={report.createdAt} className="scope">{formatUtc(report.createdAt)} UTC</time></span>
            </div>
            <div className="hero-actions">
              <button type="button" aria-expanded={sandboxOpen} aria-controls="sandbox-panel" onClick={() => setSandboxOpen(!sandboxOpen)}>
                <Icon name="panelRight" size={15} />{sandboxOpen ? "Hide sandbox" : "Show sandbox"}
              </button>
              <a className="button-link" href={assetUrl("report.json")}><Icon name="download" size={15} />Download report</a>
            </div>
          </div>
          <div className={`verdict ${verdictKey}`} role="status">
            <div className="verdict-head">
              <span className={`verdict-tile ${verdictKey}`}><StatusIcon state={summary.verdict} size={20} /></span>
              <div>
                <strong className={`badge ${verdictKey}`} title="The result of the evidence selected for this report, not a merge approval.">
                  Selected evidence: {summary.verdict}
                </strong>
                <p>{verdictLine(summary.verdict, failures.length, incompletes.length, report.gaps.length)}</p>
              </div>
            </div>
            <dl className="summary">
              {summary.tests > 0 && <div><dt>Tests</dt><dd>{summary.passedTests}/{summary.tests}</dd></div>}
              {summary.assertions > 0 && <div><dt>Checks</dt><dd>{summary.passedAssertions}/{summary.assertions}</dd></div>}
              <div><dt>Screenshots</dt><dd>{summary.images}</dd></div>
            </dl>
          </div>
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
      </header>
      <aside id="sandbox-panel" className="sandbox-sidebar" aria-label="Your sandbox" hidden={!sandboxOpen}>
        <LaunchPreview id={id} connected={connected} providerLabel={providerLabel} providers={previewProviders} />
      </aside>
      {sections.length > 1 && <EvidenceMap sections={sections} onJump={jumpTo} />}
      <div className="report-body">
        <div className="filter-bar" aria-label="Filter evidence">
          <div className="segmented">
            {["All", "Failed", "Incomplete"].map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value} <span className="count">{value === "All" ? sections.length : sections.filter((section) => section.verdict === value).length}</span></button>)}
          </div>
          <button type="button" className="quiet" disabled={!failures.length} onClick={nextFailure}><Icon name="arrowDown" size={14} />Next failure</button>
          <span role="status">{visibleSections.length} of {sections.length} sections</span>
        </div>
        <label className="section-picker">Jump to section
          <select aria-label="Jump to section" value="" onChange={(event) => { window.location.hash = event.target.value; document.getElementById(event.target.value)?.focus(); }}>
            <option value="" disabled>Choose a section</option>
            {visibleSections.map((section) => <option key={section.id} value={section.id}>{section.title} — {section.verdict}</option>)}
          </select>
        </label>
        <nav className="contents" aria-label="Report sections">
          <p className="contents-title">Sections</p>
          {visibleSections.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={section.verdict.toLowerCase()}>
              <span className="nav-number">{section.number}</span>
              <StatusIcon state={section.verdict} size={14} />
              <span className="nav-title">{section.title}<span className="visually-hidden"> — {section.verdict}</span></span>
            </a>
          ))}
        </nav>
        <div className="sections">
          {visibleSections.length === 0 && <p className="empty">No {filter.toLowerCase()} sections. <button type="button" onClick={() => setFilter("All")}>Show all evidence</button></p>}
          {visibleSections.map((section) => {
            const { source, assertions, images, verdict } = section;
            const passed = assertions.filter((item) => item.state === "passed").length;
            const key = verdict.toLowerCase();
            return (
              <section className={`section ${key}`} id={section.id} key={section.id} tabIndex={-1} aria-labelledby={`${section.id}-title`}>
                <div className="section-heading">
                  <span className="section-number" aria-hidden="true">{section.number}</span>
                  <div>
                    <h2 id={`${section.id}-title`}>{section.title}</h2>
                    <div className="section-tags">
                      <span className={`result ${key}`}><StatusIcon state={verdict} size={13} />{verdict}</span>
                      {source.kind === "docshot"
                        ? <span className="eyebrow">Documentation reference</span>
                        : <span className="tag-muted">Test run</span>}
                      {images.length > 0 && <span className="tag-muted">{images.length} {images.length === 1 ? "screenshot" : "screenshots"}</span>}
                    </div>
                  </div>
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
                  <p className="outcome missing">
                    No assertion evidence was recorded for this run.
                  </p>
                )}
                {images.length > 0 && <ol className="gallery" aria-label="Screenshots">
                  {images.map((item, index) => {
                    const visual = visualState(item);
                    const notes = designNotesLabel(item);
                    const repeat = isRepeat(item);
                    const change = describeChange(item, index);
                    const closing = closesStep(images, index);
                    const checks = closing ? stepChecks(report, item).flatMap((entry) => entry.judgments) : [];
                    const found = closing ? stepFound(images, item) : [];
                    return (
                      <li key={item.id} className={repeat ? "repeat" : undefined}>
                        <figure>
                          <figcaption>
                            <span className="step-number">{index + 1}</span>
                            <strong>{item.caption}</strong>
                          </figcaption>
                          {!repeat && <a className="image-link" href={`#evidence-${item.id}`} aria-label={`Inspect ${item.caption}`}>
                            <MarkedShot image={item} src={assetUrl(item.asset)} alt={item.caption} loading="lazy" maxChanges={2} />
                            {item.checkpoint && <span className="saved-browser" title="Open the screenshot to enter a private copy of this browser."><Icon name="globe" size={12} />Saved browser</span>}
                            {item.failure && <span className="failed-here">Failed here</span>}
                          </a>}
                          {change && <p className="change">{change}{repeat && <> <a href={`#evidence-${item.id}`}>View</a></>}</p>}
                          {item.settled === false && <p>Still changing when captured.</p>}
                          {(item.description || visual || notes) && (
                            <div className="figure-meta">
                              {item.description && <p>{item.description}</p>}
                              {(visual || notes) && <div className="figure-chips">
                                {visual && (
                                  <span className={visual === "failed" ? "result failed" : visual === "pending" ? "result pending" : "visual-passed"}>
                                    <StatusIcon state={visual} size={12} />
                                    Visual checks {item.judgments.filter((judgment) => judgment.state === "passed").length}/{item.judgments.length} passed
                                  </span>
                                )}
                                {notes && <span className={`design-notes-count${item.designNotes?.some((note) => note.severity === "medium") ? " medium" : ""}`}>{notes}</span>}
                              </div>}
                            </div>
                          )}
                          {checks.length > 0 && <ul className="proof" aria-label="Checked in this step">
                            {checks.map((judgment, checkIndex) => (
                              <li key={checkIndex} className={judgment.state}>
                                <StatusIcon state={judgment.state} />
                                <span>{judgment.expectation}{judgment.reasoning && <span className="observed">{judgment.reasoning}</span>}</span>
                              </li>
                            ))}
                          </ul>}
                          {found.length > 0 && <p className="found">Found on screen: {found.slice(0, 3).map((label) => `“${label}”`).join(", ")}{found.length > 3 ? ` and ${found.length - 3} more` : ""}.</p>}
                          {closing && item.step !== undefined && checks.length === 0 && found.length === 0 && item.judgments.length === 0 && <p className="unchecked">Nothing was checked in this step.</p>}
                        </figure>
                      </li>
                    );
                  })}
                </ol>}
                <details className="provenance">
                  <summary>Source and diagnostics</summary>
                  <div className="source-row">
                    {source.name !== section.title && <span>{source.name}</span>}
                    <code title={source.gitSha}>{source.gitSha.slice(0, 7)}</code>
                    <span>Captured {formatUtc(source.createdAt)} UTC</span>
                    <CopyButton label="Copy section link" value={`#${section.id}`} link />
                    <a href={assetUrl(source.asset)} target="_blank" rel="noreferrer">{source.kind === "test-run" ? "View record and trace" : "View receipt"}<Icon name="externalLink" size={12} /></a>
                  </div>
                </details>
              </section>
            );
          })}
        </div>
      </div>
      <EvidenceViewer report={report} id={id} checkpointProviders={checkpointProviders} />
      <footer>
        Recorded evidence. Discussion and approval stay on the pull request.
      </footer>
    </main></CheckpointProvider>
  );
}

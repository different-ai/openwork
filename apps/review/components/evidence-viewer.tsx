"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewReport } from "@openwork/review";
import { CopyButton } from "./copy-button";
import { MarkedShot } from "./marked-shot";
import { OpenCheckpoint } from "./open-checkpoint";
import { describeAction, describeChange, stepChecks } from "../lib/change";

export function EvidenceViewer({ report, id, connected = false }: { report: ReviewReport; id: string; connected?: boolean }) {
  const images = report.evidence.filter((item) => item.kind === "image");
  const [selected, setSelected] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [marks, setMarks] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const index = images.findIndex((item) => item.id === selected);
  const item = images[index];
  const source = item && report.sources.find((entry) => entry.id === item.sourceId);
  const inStep = item ? stepChecks(report, item) : [];
  const assertions = report.evidence.filter((entry) => entry.sourceId === item?.sourceId && entry.kind === "assertion" && !inStep.includes(entry)).flatMap((entry) => entry.judgments);
  const sectionImages = images.filter((entry) => entry.sourceId === item?.sourceId);
  const change = item ? describeChange(item, sectionImages.indexOf(item)) : "";
  const marked = Boolean(item?.size && ((item.focus?.length ?? 0) > 0 || (item.change && item.change.since !== null && item.change.ratio > 0 && item.change.ratio < 0.5)));

  useEffect(() => {
    function sync() {
      setSelected(window.location.hash.startsWith("#evidence-") ? window.location.hash.slice(10) : null);
      setActualSize(false);
    }
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (item && !dialog.current?.open) dialog.current?.showModal();
    if (!item && dialog.current?.open) dialog.current?.close();
  }, [item]);
  function close() {
    setSelected(null);
    if (window.location.hash.startsWith("#evidence-")) history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  function move(offset: number) {
    const next = images[index + offset];
    if (next) window.location.hash = `evidence-${next.id}`;
  }
  return <dialog ref={dialog} className="evidence-viewer" aria-labelledby="viewer-title" onClose={close} onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  }}>
    {item && <>
      <header className="viewer-toolbar">
        <h2 id="viewer-title">{item.caption}</h2>
        <span>{index + 1} of {images.length}</span>
        <button type="button" onClick={() => move(-1)} disabled={index === 0} aria-keyshortcuts="ArrowLeft">Previous <kbd>←</kbd></button>
        <button type="button" onClick={() => move(1)} disabled={index === images.length - 1} aria-keyshortcuts="ArrowRight">Next <kbd>→</kbd></button>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? "Fit to width" : "100% zoom"}</button>
        {marked && <button type="button" aria-pressed={marks} onClick={() => setMarks(!marks)}>{marks ? "Hide marks" : "Show marks"}</button>}
        <button type="button" onClick={() => dialog.current?.close()}>Close <kbd>esc</kbd></button>
      </header>
      <div className="viewer-body">
        <div className={`viewer-image${actualSize ? " actual-size" : ""}${marks ? "" : " marks-hidden"}`} tabIndex={0} aria-label="Screenshot"><MarkedShot image={item} src={`/r/${id}/assets/${item.asset}`} alt={item.caption} labels actualSize={actualSize} /></div>
        <aside className="viewer-context" aria-label="Evidence context">
          <OpenCheckpoint key={item.id} id={id} image={item} connected={connected} />
          <CopyButton label="Copy image link" value={`#evidence-${item.id}`} link />
          <p>{item.description}</p>
          <p>{source?.name}</p>
          <code>{report.gitSha.slice(0, 7)}</code>
          {item.change && item.change.since !== null && <>
            <h3>What changed</h3>
            <p>{change}</p>
            {item.change.actions.length > 2 && <p className="scope">Before that: {item.change.actions.slice(0, -2).map(describeAction).join(", ")}.</p>}
            {item.change.added.length > 0 && <ul className="lines added" aria-label="Appeared">{item.change.added.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>}
            {item.change.removed.length > 0 && <ul className="lines removed" aria-label="Went away">{item.change.removed.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>}
          </>}
          {item.settled === false && <p>The screen was still changing when this was captured.</p>}
          {(item.focus?.length ?? 0) > 0 && <><h3>Found on screen</h3><ul className="lines found">{item.focus?.map((entry, focusIndex) => <li key={focusIndex}>{entry.label}</li>)}</ul></>}
          {inStep.length > 0 && <><h3>Checked in this step</h3>{inStep.flatMap((entry) => entry.judgments).map((judgment, judgmentIndex) => <div className="viewer-judgment" key={judgmentIndex}><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>)}</>}
          <h3>Visual checks</h3>
          {!item.judgments.length && <p>No visual judgment recorded.</p>}
          {item.judgments.map((judgment, index) => <div className="viewer-judgment" key={index}><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>)}
          {assertions.length > 0 && <><h3>{inStep.length > 0 ? "Other checks in this test" : "Source assertions"}</h3>{assertions.map((judgment, index) => <div className="viewer-judgment" key={index}><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>)}</>}
          {source && <a href={`/r/${id}/assets/${source.asset}`} target="_blank" rel="noreferrer">View record and trace</a>}
        </aside>
      </div>
    </>}
  </dialog>;
}

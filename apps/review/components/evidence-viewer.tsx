"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewReport } from "@openwork/review";
import { CopyButton } from "./copy-button";

export function EvidenceViewer({ report, id }: { report: ReviewReport; id: string }) {
  const images = report.evidence.filter((item) => item.kind === "image");
  const [selected, setSelected] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const index = images.findIndex((item) => item.id === selected);
  const item = images[index];
  const source = item && report.sources.find((entry) => entry.id === item.sourceId);
  const assertions = report.evidence.filter((entry) => entry.sourceId === item?.sourceId && entry.kind === "assertion").flatMap((entry) => entry.judgments);

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
        <button type="button" onClick={() => dialog.current?.close()}>Close <kbd>esc</kbd></button>
      </header>
      <div className="viewer-body">
        <div className={`viewer-image${actualSize ? " actual-size" : ""}`} tabIndex={0} aria-label="Screenshot"><img src={`/r/${id}/assets/${item.asset}`} alt={item.caption} /></div>
        <aside className="viewer-context" aria-label="Evidence context">
          <CopyButton label="Copy image link" value={`#evidence-${item.id}`} link />
          <p>{item.description}</p>
          <p>{source?.name}</p>
          <code>{report.gitSha.slice(0, 7)}</code>
          <h3>Visual checks</h3>
          {!item.judgments.length && <p>No visual judgment recorded.</p>}
          {item.judgments.map((judgment, index) => <div className="viewer-judgment" key={index}><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>)}
          {assertions.length > 0 && <><h3>Source assertions</h3>{assertions.map((judgment, index) => <div className="viewer-judgment" key={index}><strong>{judgment.expectation}</strong><span className={`result ${judgment.state}`}>{judgment.state}</span><p>{judgment.reasoning}</p></div>)}</>}
          {source && <a href={`/r/${id}/assets/${source.asset}`} target="_blank" rel="noreferrer">View record and trace</a>}
        </aside>
      </div>
    </>}
  </dialog>;
}

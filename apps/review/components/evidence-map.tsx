import { Icon } from "./icons";
import { StatusIcon } from "./status-icon";
import { designNotesLabel, visualState, type ReportSection } from "../lib/sections";

/**
 * One lane per section, one card per recorded step, read left to right.
 * Lanes jump to their section; step cards open the screenshot viewer.
 */
export function EvidenceMap({ sections, onJump }: { sections: readonly ReportSection[]; onJump: (id: string) => void }) {
  return (
    <section className="block evidence-map" aria-labelledby="evidence-map-title">
      <h2 id="evidence-map-title">Evidence map</h2>
      <ol className="map">
        {sections.map((section) => {
          const { source, assertions, images, verdict } = section;
          const passed = assertions.filter((item) => item.state === "passed").length;
          const failedChecks = assertions.filter((item) => item.state === "failed");
          const key = verdict.toLowerCase();
          return (
            <li key={section.id} className={`map-lane ${key}`}>
              <a className="lane" href={`#${section.id}`} onClick={(event) => { event.preventDefault(); onJump(section.id); }}>
                <span className="lane-head">
                  <span className="lane-number">{section.number}</span>
                  <StatusIcon state={verdict} size={14} />
                  <span className={`lane-verdict ${key}`}>{verdict}</span>
                </span>
                <strong>{section.title}</strong>
              </a>
              <ol className="map-nodes">
                {source.kind === "test-run" && (
                  <li>
                    <a className={`node node-checks${failedChecks.length || source.outcome === "failed" ? " failed" : assertions.length ? "" : " muted"}`}
                      href={`#${section.id}`} onClick={(event) => { event.preventDefault(); onJump(section.id); }}>
                      <span className="node-kind"><Icon name="listChecks" size={13} />Checks</span>
                      <b>{assertions.length ? `${passed} of ${assertions.length} passed` : "No assertion evidence"}</b>
                      {source.outcome !== "passed" && <span className={`node-alert${source.outcome === "failed" ? "" : " pending"}`}>Execution {source.outcome}</span>}
                      {failedChecks.slice(0, 2).map((item, index) => <span key={index} className="node-alert">{item.expectation}</span>)}
                    </a>
                  </li>
                )}
                {images.map((item, index) => {
                  const visual = visualState(item);
                  const notes = designNotesLabel(item);
                  return (
                    <li key={item.id}>
                      <a className={`node${visual === "failed" ? " failed" : ""}`} href={`#evidence-${item.id}`} aria-label={`Inspect ${item.caption}`}>
                        <span className="node-kind"><span className="node-step">{index + 1}</span>Screenshot</span>
                        <b>{item.caption}</b>
                        {item.description && <span className="node-text">{item.description}</span>}
                        {(visual || notes || item.checkpoint) && (
                          <span className="refs">
                            {visual === "failed" && <span className="ref failed">Visual check failed</span>}
                            {visual === "pending" && <span className="ref pending">Visual pending</span>}
                            {notes && <span className={`ref${item.designNotes?.some((note) => note.severity === "medium") ? " pending" : ""}`}>{notes.replace(/, .*/, "")}</span>}
                            {item.checkpoint && <span className="ref handoff"><Icon name="globe" size={11} />Saved browser</span>}
                          </span>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

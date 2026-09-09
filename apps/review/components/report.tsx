import { summarizeReview } from "@openwork/review";
import type { ReviewEvidence, ReviewReport } from "@openwork/review";

function Judgments({ items }: { items: ReviewEvidence["judgments"] }) {
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

export function Report({ report, id }: { report: ReviewReport; id: string }) {
  const summary = summarizeReview(report);
  const assetUrl = (name: string) => `/r/${id}/assets/${name}`;
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  return (
    <main className="report">
      <div className="intro">
        <p className="eyebrow">
          Change verification <span> / {report.gitSha.slice(0, 7)}</span>
        </p>
        <h1>{report.title}</h1>
        <div className="summary">
          <span className={`badge ${summary.verdict.toLowerCase()}`}>
            {summary.verdict}
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
          Results cover the selected evidence below.{" "}
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
      <div className="report-body">
        <nav className="contents" aria-label="Report sections">
          <p className="eyebrow">In this review</p>
          {report.sections.map((section, index) => (
            <a key={section.id} href={`#${section.id}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {section.title}
            </a>
          ))}
          <a className="download" href={assetUrl("report.json")}>
            Download report ↗
          </a>
        </nav>
        <div className="sections">
          {report.sections.map((section, index) => {
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
              <section className="section" id={section.id} key={section.id}>
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
                        href={assetUrl(item.asset)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={assetUrl(item.asset)}
                          alt={item.caption}
                          loading="lazy"
                        />
                      </a>
                      <figcaption>
                        <strong>{item.caption}</strong>
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
                    ↗
                  </a>
                </details>
              </section>
            );
          })}
        </div>
      </div>
      <footer>
        Recorded evidence · Human discussion and approval remain on the pull
        request.
      </footer>
    </main>
  );
}

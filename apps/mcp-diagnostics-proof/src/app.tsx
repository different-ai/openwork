import { useEffect, useMemo, useRef, useState } from "react"
import { chapterIdFromHash } from "./chapter-hash"
import { evidenceAssets } from "./evidence"
import {
  chapters,
  proofBoundaries,
  proofMetadata,
  releaseStatus,
  replayCommands,
  type ProofFrame,
} from "./story"

const REVIEW_STORAGE_KEY = "openwork-mcp-diagnostics-proof-reviewed"
const chapterIds = chapters.map((chapter) => chapter.id)

function reviewedChaptersFromStorage() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(REVIEW_STORAGE_KEY) ?? "[]")
    if (!Array.isArray(stored)) return new Set<string>()
    return new Set(
      stored.filter(
        (id): id is string =>
          typeof id === "string" && chapters.some((chapter) => chapter.id === id),
      ),
    )
  } catch {
    return new Set<string>()
  }
}

function chapterIndexFromHash() {
  const id = chapterIdFromHash(window.location.hash, chapterIds)
  if (!id) return 0
  const index = chapters.findIndex((chapter) => chapter.id === id)
  return index === -1 ? 0 : index
}

function isTextEntryTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable)
  )
}

export function App() {
  const [chapterIndex, setChapterIndex] = useState(chapterIndexFromHash)
  const [expandedFrame, setExpandedFrame] = useState<ProofFrame | null>(null)
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [reviewedChapters, setReviewedChapters] = useState(reviewedChaptersFromStorage)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const chapter = chapters[chapterIndex]
  const totalFrames = useMemo(
    () => chapters.reduce((count, entry) => count + entry.frames.length, 0),
    [],
  )

  function goToChapter(nextIndex: number, options?: { focus?: boolean }) {
    const boundedIndex = Math.max(0, Math.min(chapters.length - 1, nextIndex))
    const nextChapter = chapters[boundedIndex]
    if (window.location.hash !== `#${nextChapter.id}`) {
      window.location.hash = nextChapter.id
      return
    }
    setChapterIndex(boundedIndex)
    if (options?.focus !== false) headingRef.current?.focus()
  }

  useEffect(() => {
    if (chapterIdFromHash(window.location.hash, chapterIds) !== chapters[chapterIndex].id) {
      window.history.replaceState(null, "", `#${chapters[chapterIndex].id}`)
    }

    const handleHashChange = () => {
      const nextIndex = chapterIndexFromHash()
      if (chapterIdFromHash(window.location.hash, chapterIds) !== chapters[nextIndex].id) {
        window.history.replaceState(null, "", `#${chapters[nextIndex].id}`)
      }
      setChapterIndex(nextIndex)
      window.requestAnimationFrame(() => headingRef.current?.focus())
    }
    window.addEventListener("hashchange", handleHashChange)
    return () => window.removeEventListener("hashchange", handleHashChange)
  }, [chapterIndex])

  useEffect(() => {
    document.title = `${chapter.label}: ${chapter.title} · MCP diagnostics proof`
  }, [chapter])

  useEffect(() => {
    window.localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify([...reviewedChapters]))
  }, [reviewedChapters])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        expandedFrame ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTextEntryTarget(event.target)
      ) {
        return
      }
      if (event.key === "ArrowRight" && chapterIndex < chapters.length - 1) {
        event.preventDefault()
        goToChapter(chapterIndex + 1)
      }
      if (event.key === "ArrowLeft" && chapterIndex > 0) {
        event.preventDefault()
        goToChapter(chapterIndex - 1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [chapterIndex, expandedFrame])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!expandedFrame || !dialog || dialog.open) return
    dialog.showModal()
  }, [expandedFrame])

  function closeExpandedFrame() {
    dialogRef.current?.close()
    setExpandedFrame(null)
    window.requestAnimationFrame(() => openerRef.current?.focus())
  }

  async function copyCommand(command: string) {
    await navigator.clipboard.writeText(command)
    setCopiedCommand(command)
    window.setTimeout(() => setCopiedCommand((current) => (current === command ? null : current)), 1_500)
  }

  function setChapterReviewed(reviewed: boolean) {
    setReviewedChapters((current) => {
      const next = new Set(current)
      if (reviewed) next.add(chapter.id)
      else next.delete(chapter.id)
      return next
    })
  }

  return (
    <>
      <button
        className="skip-link"
        data-testid="skip-to-proof-chapter"
        type="button"
        onClick={() => {
          headingRef.current?.focus()
          document.getElementById("proof-chapter")?.scrollIntoView({ block: "start" })
        }}
      >
        Skip to the current proof chapter
      </button>

      <div className="page-shell" data-testid="mcp-diagnostics-proof-app">
        <header className="hero">
          <div className="hero__copy">
            <p className="eyebrow">OpenWork · independent MCP rehearsal</p>
            <h1>Replay the proof as one understandable story</h1>
            <p className="hero__lede">
              Walk through the exact enterprise-style scenario the agent replayed: controlled
              setup, owned failure, confidential OAuth, read-only catalog proof, live repair,
              provider denial, and cleanup.
            </p>

            <div className="hero__actions">
              <button
                className="button button--primary"
                type="button"
                onClick={() => {
                  goToChapter(0)
                  document.getElementById("proof-chapter")?.scrollIntoView({ behavior: "smooth" })
                }}
              >
                Start with setup
              </button>
              <a
                className="button button--secondary"
                href={proofMetadata.rehearsalPr.url}
                target="_blank"
                rel="noreferrer"
              >
                Open rehearsal PR
              </a>
            </div>
          </div>

          <div className="hero__record" aria-label="Proof provenance">
            <p className="eyebrow eyebrow--muted">Evidence record</p>
            <dl>
              <div>
                <dt>Branch</dt>
                <dd>{proofMetadata.branch}</dd>
              </div>
              <div>
                <dt>Evidence run</dt>
                <dd>{proofMetadata.baselineRun}</dd>
              </div>
              <div>
                <dt>Product baseline</dt>
                <dd>{proofMetadata.baselineHead}</dd>
              </div>
              <div>
                <dt>Focused checks</dt>
                <dd>{proofMetadata.automatedResult}</dd>
              </div>
              <div>
                <dt>Browser replay</dt>
                <dd>{proofMetadata.browserResult}</dd>
              </div>
              <div>
                <dt>Your local walkthrough</dt>
                <dd>
                  {reviewedChapters.size} / {chapters.length} chapters reviewed
                </dd>
              </div>
            </dl>
          </div>
        </header>

        <section className="status-grid" aria-label="Current release status">
          {releaseStatus.map((status) => (
            <article className={`status-card status-card--${status.tone}`} key={status.id}>
              <p>{status.label}</p>
              <strong>{status.value}</strong>
              <span>{status.detail}</span>
            </article>
          ))}
        </section>

        <section className="boundary-grid" aria-labelledby="proof-boundary-title">
          <div className="boundary-intro">
            <p className="eyebrow">Review boundary</p>
            <h2 id="proof-boundary-title">Evidence, not approval</h2>
            <p>
              This viewer explains an independent agent replay. It does not mark a checkpoint as
              verified by Jalil and does not integrate code into the controlled parent.
            </p>
            <div className="boundary-links">
              <a href={proofMetadata.rehearsalPr.url} target="_blank" rel="noreferrer">
                {proofMetadata.rehearsalPr.label}
              </a>
              <a href={proofMetadata.parentPr.url} target="_blank" rel="noreferrer">
                {proofMetadata.parentPr.label}
              </a>
            </div>
          </div>
          <BoundaryList title="What this proves" items={proofBoundaries.proves} tone="positive" />
          <BoundaryList
            title="What this does not prove"
            items={proofBoundaries.doesNotProve}
            tone="caution"
          />
        </section>

        <div className="tour-layout">
          <aside className="tour-nav" aria-label="Proof chapters">
            <div className="tour-nav__header">
              <div>
                <p className="eyebrow eyebrow--muted">Your position</p>
                <strong>
                  Chapter {chapterIndex + 1} of {chapters.length}
                </strong>
              </div>
              <span>{Math.round(((chapterIndex + 1) / chapters.length) * 100)}%</span>
            </div>
            <progress value={chapterIndex + 1} max={chapters.length}>
              Chapter {chapterIndex + 1} of {chapters.length}
            </progress>
            <p className="tour-nav__count" data-testid="proof-story-count">
              {chapters.length} operational chapters · {totalFrames} evidence frames
            </p>
            <ol>
              {chapters.map((entry, index) => (
                <li key={entry.id}>
                  <button
                    className={index === chapterIndex ? "chapter-link chapter-link--active" : "chapter-link"}
                    type="button"
                    aria-current={index === chapterIndex ? "step" : undefined}
                    data-testid={`chapter-link-${entry.id}`}
                    onClick={() => goToChapter(index)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <small>{entry.label}</small>
                      <strong>{entry.title}</strong>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <p className="keyboard-hint">Use ← and → to move between chapters.</p>
          </aside>

          <main
            className="chapter"
            id="proof-chapter"
            data-testid="current-proof-chapter"
            data-chapter-id={chapter.id}
            aria-live="polite"
          >
            <header className="chapter__header">
              <div className="chapter__labels">
                <span className="tag">{chapter.label}</span>
                <span className="tag tag--quiet">{chapter.level}</span>
                <span className="tag tag--risk">{chapter.blocker}</span>
              </div>
              <h2 ref={headingRef} tabIndex={-1}>
                {chapter.title}
              </h2>
              <p>{chapter.summary}</p>
              {chapter.source ? (
                <a
                  className="source-link"
                  data-testid="chapter-source-pr"
                  href={chapter.source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {chapter.source.label} · {chapter.source.revision}
                </a>
              ) : (
                <span className="source-link source-link--plain">Rehearsal setup contract</span>
              )}
            </header>

            <section className={chapter.frames.length > 1 ? "frame-grid frame-grid--double" : "frame-grid"}>
              {chapter.frames.map((frame) => (
                <figure className="evidence-frame" data-testid="evidence-frame" key={frame.id}>
                  <button
                    className="frame-button"
                    type="button"
                    aria-label={`Expand ${frame.title}`}
                    data-testid={`expand-frame-${frame.id}`}
                    onClick={(event) => {
                      openerRef.current = event.currentTarget
                      setExpandedFrame(frame)
                    }}
                  >
                    <img
                      src={evidenceAssets[frame.asset]}
                      alt={frame.alt}
                      data-evidence-asset={frame.asset}
                    />
                    <span>Open full size</span>
                  </button>
                  <figcaption>
                    <p className="eyebrow eyebrow--muted">Captured evidence</p>
                    <h3>{frame.title}</h3>
                    <p>{frame.caption}</p>
                    <div className="look-for">
                      <strong>Look for</strong>
                      <ul>
                        {frame.lookFor.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </section>

            <section className="explanation-grid" aria-label="Chapter explanation">
              <ExplanationCard title="What the operator did" items={[chapter.operatorAction]} icon="1" />
              <ExplanationCard title="What the screen proves" items={chapter.visibleProof} icon="2" />
              <ExplanationCard title="What automation also proved" items={chapter.machineProof} icon="3" />
            </section>

            {chapter.apiEvidence ? (
              <section className="api-evidence" data-testid="provider-denial-api-evidence">
                <div>
                  <p className="eyebrow">Step 6 · authoritative API evidence</p>
                  <h3>The screenshot and API assertions prove different parts</h3>
                  <p>
                    The screenshot shows that connection and catalog health stayed healthy. These
                    machine assertions are the evidence for the denied provider operation.
                  </p>
                </div>
                <ul>
                  {chapter.apiEvidence.map((item) => (
                    <li key={item}>
                      <code>{item}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="finding" aria-label="Finding and resolution">
              <div>
                <p className="eyebrow eyebrow--danger">Failure found</p>
                <p>{chapter.failureFound}</p>
              </div>
              <div>
                <p className="eyebrow eyebrow--success">What changed</p>
                <p>{chapter.resolution}</p>
              </div>
            </section>

            {chapter.limitation ? (
              <aside className="limitation">
                <strong>Boundary to remember</strong>
                <p>{chapter.limitation}</p>
              </aside>
            ) : null}

            <section className="review-checkpoint" aria-label="Local review checkpoint">
              <div>
                <p className="eyebrow">Your review checkpoint</p>
                <strong>Record that you inspected this chapter</strong>
                <p>
                  This checklist stays only in this browser. It does not approve a PR or change the
                  official “Jalil verification: Not started” release status.
                </p>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={reviewedChapters.has(chapter.id)}
                  onChange={(event) => setChapterReviewed(event.currentTarget.checked)}
                />
                I reviewed {chapter.label}
              </label>
              {reviewedChapters.size > 0 ? (
                <button type="button" onClick={() => setReviewedChapters(new Set())}>
                  Reset local review
                </button>
              ) : null}
            </section>

            <nav className="chapter-controls" aria-label="Chapter navigation">
              <button
                className="button button--secondary"
                type="button"
                data-testid="previous-chapter"
                disabled={chapterIndex === 0}
                onClick={() => goToChapter(chapterIndex - 1)}
              >
                ← Previous
              </button>
              <span>
                {chapterIndex + 1} / {chapters.length}
              </span>
              <button
                className="button button--primary"
                type="button"
                data-testid="next-chapter"
                disabled={chapterIndex === chapters.length - 1}
                onClick={() => goToChapter(chapterIndex + 1)}
              >
                Next →
              </button>
            </nav>
          </main>
        </div>

        <section className="replay" aria-labelledby="replay-title">
          <div>
            <p className="eyebrow">Run it yourself</p>
            <h2 id="replay-title">Replay and verify, one layer at a time</h2>
            <p>
              Start with this viewer. When a chapter makes sense, use the underlying Fraimz command
              to reproduce the product behavior in the isolated rehearsal environment.
            </p>
          </div>
          <div className="command-list">
            {replayCommands.map((entry) => (
              <div className="command" key={entry.label}>
                <div>
                  <strong>{entry.label}</strong>
                  <code>{entry.command}</code>
                </div>
                <button type="button" onClick={() => void copyCommand(entry.command)}>
                  {copiedCommand === entry.command ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          </div>
        </section>

        <footer>
          <p>
            Independent proof viewer · Agent verified · Jalil verification not started · Controlled
            parent none integrated
          </p>
        </footer>
      </div>

      {expandedFrame ? (
        <dialog
          className="image-dialog"
          ref={dialogRef}
          aria-labelledby="expanded-frame-title"
          onClose={closeExpandedFrame}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeExpandedFrame()
          }}
        >
          <div>
            <div className="image-dialog__header">
              <div>
                <p className="eyebrow eyebrow--muted">Full-size evidence</p>
                <h2 id="expanded-frame-title">{expandedFrame.title}</h2>
              </div>
              <button type="button" autoFocus onClick={closeExpandedFrame} aria-label="Close image">
                Close
              </button>
            </div>
            <img src={evidenceAssets[expandedFrame.asset]} alt={expandedFrame.alt} />
            <p>{expandedFrame.caption}</p>
          </div>
        </dialog>
      ) : null}
    </>
  )
}

function BoundaryList({
  title,
  items,
  tone,
}: {
  title: string
  items: readonly string[]
  tone: "positive" | "caution"
}) {
  return (
    <article className={`boundary-list boundary-list--${tone}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  )
}

function ExplanationCard({
  title,
  items,
  icon,
}: {
  title: string
  items: readonly string[]
  icon: string
}) {
  return (
    <article className="explanation-card">
      <span aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  )
}

import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerMemoryFile, type CoworkerSummary } from "@/lib/bridge";
import { Button, Empty, ErrorNote } from "@/ui/kit";

/**
 * Memory stays inspectable Markdown. The editor follows coworker writes live
 * without replacing unsaved human edits.
 */
export function MemoryPanel({ coworker }: { coworker: CoworkerSummary }) {
  const [files, setFiles] = useState<CoworkerMemoryFile[]>([]);
  const [selectedId, setSelectedId] = useState("working");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [error, setError] = useState("");

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await coworkerBridge.files.list(coworker.slug));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [coworker.slug]);

  useEffect(() => {
    setSelectedId("working");
    void refreshFiles();
  }, [refreshFiles]);

  const selected = files.find((file) => file.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void coworkerBridge.files
      .read(coworker.slug, selected.path)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.slug, selected]);

  const editorState = useRef({ content: "", savedContent: "" });
  editorState.current = { content, savedContent };
  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => {
      void coworkerBridge.files
        .read(coworker.slug, selected.path)
        .then((text) => {
          const { content: currentContent, savedContent: currentSaved } = editorState.current;
          const dirty = currentContent !== currentSaved;
          if (!dirty && text !== currentSaved) {
            setContent(text);
            setSavedContent(text);
          }
        })
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [coworker.slug, selected]);

  async function save() {
    if (!selected) return;
    try {
      await coworkerBridge.files.write(coworker.slug, selected.path, content);
      setSavedContent(content);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const dirty = content !== savedContent;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-mist">Human-readable context that {coworker.name} can maintain.</p>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" className="px-2 text-xs" onClick={() => void refreshFiles()}>Refresh</Button>
          <Button variant="primary" className="px-2 text-xs" disabled={!dirty} onClick={() => void save()}>{dirty ? "Save" : "Saved"}</Button>
        </div>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <nav className="flex gap-1 overflow-x-auto pb-1">
        {files.map((file) => (
          <button
            key={file.id}
            onClick={() => setSelectedId(file.id)}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              file.id === selectedId ? "bg-panel-2 text-snow" : "text-mist hover:bg-panel hover:text-snow"
            }`}
          >
            {file.label}
          </button>
        ))}
      </nav>
      {files.length === 0 ? <Empty>No memory files yet.</Empty> : null}
      {selected ? (
        <>
          <textarea
            aria-label={`${selected.label} memory`}
            className="h-[58vh] w-full resize-none rounded-2xl border border-line bg-ink p-3 font-mono text-xs leading-relaxed text-snow focus:border-spark/60 focus:outline-none"
            value={content}
            spellCheck={false}
            onChange={(event) => setContent(event.target.value)}
          />
          <p className="text-[10px] leading-relaxed text-mist">Live-following coworker edits. Your unsaved changes are never replaced.</p>
        </>
      ) : null}
    </div>
  );
}

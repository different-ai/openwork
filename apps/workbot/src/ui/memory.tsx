import { useCallback, useEffect, useRef, useState } from "react";
import { workbot, type BotMemoryFile, type BotSummary } from "@/lib/bridge";
import { Button, Empty, ErrorNote, Section } from "@/ui/kit";

/**
 * Memory is files, on purpose: the worker maintains `memory/working.md`
 * itself, long-term memories are separate Markdown documents behind a small
 * always-loaded index, and everything is inspectable and editable here.
 */
export function MemoryPanel({ bot }: { bot: BotSummary }) {
  const [files, setFiles] = useState<BotMemoryFile[]>([]);
  const [selectedId, setSelectedId] = useState("working");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [error, setError] = useState("");

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await workbot.files.list(bot.slug));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bot.slug]);

  useEffect(() => {
    setSelectedId("working");
    void refreshFiles();
  }, [refreshFiles]);

  const selected = files.find((file) => file.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void workbot.files
      .read(bot.slug, selected.path)
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
  }, [bot.slug, selected]);

  // The worker edits these files while it works. Follow along live, but never
  // overwrite unsaved human edits.
  const editorState = useRef({ content: "", savedContent: "" });
  editorState.current = { content, savedContent };
  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => {
      void workbot.files
        .read(bot.slug, selected.path)
        .then((text) => {
          const { content: currentContent, savedContent: currentSaved } = editorState.current;
          const dirty = currentContent !== currentSaved;
          if (!dirty && text !== currentSaved) {
            setContent(text);
            setSavedContent(text);
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [bot.slug, selected]);

  async function save() {
    if (!selected) return;
    try {
      await workbot.files.write(bot.slug, selected.path, content);
      setSavedContent(content);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const dirty = content !== savedContent;

  return (
    <Section
      title="Memory"
      actions={
        <>
          <Button variant="ghost" onClick={() => void refreshFiles()}>
            Refresh
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            {dirty ? "Save" : "Saved"}
          </Button>
        </>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex gap-4">
        <nav className="w-48 shrink-0 space-y-0.5">
          {files.map((file) => (
            <button
              key={file.id}
              onClick={() => setSelectedId(file.id)}
              className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm ${
                file.id === selectedId ? "bg-panel-2 text-snow" : "text-mist hover:text-snow"
              }`}
            >
              {file.label}
            </button>
          ))}
          {files.length === 0 ? <Empty>No memory files.</Empty> : null}
        </nav>
        <div className="min-w-0 flex-1">
          <textarea
            className="h-[56vh] w-full resize-none rounded-md border border-line bg-ink p-3 font-mono text-[13px] leading-relaxed text-snow focus:border-spark/60 focus:outline-none"
            value={content}
            spellCheck={false}
            onChange={(event) => setContent(event.target.value)}
          />
          <p className="mt-2 text-xs text-mist">
            The worker edits its own working memory while it works; you can edit or prune anything
            here too. Files live in {bot.path}.
          </p>
        </div>
      </div>
    </Section>
  );
}

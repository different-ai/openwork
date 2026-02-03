import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { marked } from "marked";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { File } from "lucide-solid";
import { safeStringify } from "../utils";

type Props = {
  part: Part;
  developerMode?: boolean;
  showThinking?: boolean;
  tone?: "light" | "dark";
  renderMarkdown?: boolean;
};

function clampText(text: string, max = 800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated)`;
}

function useThrottledValue<T>(value: () => T, delayMs = 80) {
  const [state, setState] = createSignal<T>(value());
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const next = value();
    if (!delayMs) {
      setState(() => next);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      setState(() => next);
      timer = undefined;
    }, delayMs);
  });

  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  return state;
}

function createCustomRenderer(tone: "light" | "dark") {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-gray-12/10 border-gray-11/20 text-gray-12"
      : "bg-gray-1/80 border-gray-6/70 text-gray-12";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";
  
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const isSafeUrl = (url: string) => {
    const protocol = (url || "").trim().toLowerCase();
    return !protocol.startsWith("javascript:") && !protocol.startsWith("data:");
  };

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    return `
      <div class="rounded-2xl border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
          text
        )}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass}">${escapeHtml(
      text
    )}</code>`;
  };

  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "#") : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <a
        href="${safeHref}"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 text-blue-600 hover:text-blue-700"
        ${safeTitle ? `title="${safeTitle}"` : ""}
      >
        ${text}
      </a>
    `;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}

export default function PartView(props: Props) {
  const p = () => props.part;
  const developerMode = () => props.developerMode ?? false;
  const tone = () => props.tone ?? "light";
  const showThinking = () => props.showThinking ?? true;
  const renderMarkdown = () => props.renderMarkdown ?? false;
  const fileInfo = () => {
    if (p().type !== "file") return null;
    const part = p() as {
      filename?: string;
      url?: string;
      mime?: string;
      source?: {
        type?: string;
        path?: string;
        name?: string;
        clientName?: string;
        uri?: string;
      };
    };
    const source = part.source ?? {};
    const sourceType = typeof source.type === "string" ? source.type : "";
    const sourcePath = typeof source.path === "string" ? source.path : "";
    const sourceName = typeof source.name === "string" ? source.name : "";
    const sourceClient = typeof source.clientName === "string" ? source.clientName : "";
    const sourceUri = typeof source.uri === "string" ? source.uri : "";
    const filename = typeof part.filename === "string" ? part.filename : "";
    const url = typeof part.url === "string" ? part.url : "";
    const pathName = sourcePath ? sourcePath.split(/[\\/]/).pop() ?? sourcePath : "";
    const title = filename || pathName || sourceName || url || "File";
    const detail = (() => {
      if (sourceType === "symbol") {
        if (sourcePath) return `${sourceName || "symbol"} - ${sourcePath}`;
        return sourceName || "";
      }
      if (sourceType === "resource") {
        const details = [sourceClient, sourceUri].filter(Boolean).join(" - ");
        return details || url;
      }
      return sourcePath || url;
    })();
    const mime = typeof part.mime === "string" ? part.mime : "";
    return { title, detail, mime };
  };

  const textClass = () => (tone() === "dark" ? "text-gray-12" : "text-gray-12");
  const subtleTextClass = () => (tone() === "dark" ? "text-gray-12/70" : "text-gray-11");
  const panelBgClass = () => (tone() === "dark" ? "bg-gray-2/10" : "bg-gray-2/30");
  const toolOnly = () => true;
  const showToolOutput = () => developerMode();
  const markdownSource = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return "";
    return "text" in p() ? String((p() as { text: string }).text ?? "") : "";
  });
  const throttledMarkdownSource = useThrottledValue(markdownSource, 100);
  const renderedMarkdown = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return null;
    const text = throttledMarkdownSource();
    if (!text.trim()) return "";
    
    try {
      const renderer = createCustomRenderer(tone());
      const result = marked.parse(text, { 
        breaks: true, 
        gfm: true,
        renderer,
        async: false
      });
      
      return typeof result === 'string' ? result : '';
    } catch (error) {
      console.error('Markdown parsing error:', error);
      return null;
    }
  });

  const toolData = () => {
    if (p().type !== "tool") return null;
    return p() as any;
  };

  const toolState = () => toolData()?.state ?? {};
  const toolName = () => (toolData()?.tool ? String(toolData()?.tool) : "tool");
  const toolTitle = () => (toolState()?.title ? String(toolState().title) : toolName());
  const toolStatus = () => (toolState()?.status ? String(toolState().status) : "unknown");
  const toolSubtitle = () =>
    toolState()?.subtitle || toolState()?.detail || toolState()?.summary
      ? String(toolState().subtitle ?? toolState().detail ?? toolState().summary)
      : "";

  const extractDiff = () => {
    const state = toolState();
    const candidates = [state?.diff, state?.patch, state?.output];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (candidate.includes("@@") || candidate.includes("+++ ") || candidate.includes("--- ")) {
        return candidate;
      }
    }
    return null;
  };

  const diffText = createMemo(() => (p().type === "tool" ? extractDiff() : null));
  const normalizeToolText = (value: unknown) => {
    if (typeof value !== "string") return "";
    return value.replace(/(?:\r?\n\s*)+$/, "");
  };
  const diffTextNormalized = createMemo(() => normalizeToolText(diffText()));
  const diffLines = createMemo(() => (diffTextNormalized() ? diffTextNormalized().split("\n") : []));
  const diffLineClass = (line: string) => {
    if (line.startsWith("+")) return "text-green-11 bg-green-1/40";
    if (line.startsWith("-")) return "text-red-11 bg-red-1/40";
    if (line.startsWith("@@")) return "text-blue-11 bg-blue-1/30";
    return "text-gray-12";
  };

  const toolOutput = () => normalizeToolText(toolState()?.output);

  const toolError = () => {
    const error = toolState()?.error;
    return typeof error === "string" ? error : null;
  };

  const toolInput = () => toolState()?.input;

  const diagnostics = () => {
    const items = toolState()?.diagnostics;
    return Array.isArray(items) ? items : [];
  };

  const formatDiagnosticLocation = (diagnostic: any) => {
    const raw = diagnostic?.file ?? diagnostic?.path ?? diagnostic?.uri ?? "";
    const file = typeof raw === "string" ? raw.replace(/^file:\/\//, "") : "";
    const line = diagnostic?.line ?? diagnostic?.range?.start?.line;
    const character = diagnostic?.character ?? diagnostic?.range?.start?.character;
    const location =
      typeof line === "number"
        ? `${line + 1}${typeof character === "number" ? `:${character + 1}` : ""}`
        : "";
    return `${file}${file && location ? ":" : ""}${location}`.trim();
  };

  const formatDiagnosticLabel = (diagnostic: any) => {
    const severity = diagnostic?.severity ?? diagnostic?.level;
    if (typeof severity === "string") return severity;
    if (severity === 1) return "error";
    if (severity === 2) return "warning";
    if (severity === 3) return "info";
    if (severity === 4) return "hint";
    return "diagnostic";
  };

  const isLargeOutput = createMemo(() => toolOutput().length > 800);

  const [expandedOutput, setExpandedOutput] = createSignal(false);
  const outputPreview = createMemo(() => {
    const output = toolOutput();
    if (!output) return "";
    if (isLargeOutput() && !expandedOutput()) {
      return `${output.slice(0, 800)}\n\n… (truncated)`;
    }
    return output;
  });

  const toolImages = () => {
    const state = toolState();
    const candidates = Array.isArray(state?.images) ? state.images : [];
    return candidates
      .map((item: any) => {
        if (typeof item === "string") return { src: item, alt: "" };
        const src = item?.url ?? item?.src ?? item?.data;
        if (!src) return null;
        if (item?.data && item?.mediaType && !String(item.data).startsWith("data:")) {
          return { src: `data:${item.mediaType};base64,${item.data}`, alt: item?.alt ?? "" };
        }
        return { src, alt: item?.alt ?? "" };
      })
      .filter(Boolean);
  };

  const inlineImage = () => {
    if (p().type !== "file") return null;
    const record = p() as any;
    const mime = typeof record?.mime === "string" ? record.mime : "";
    if (!mime.startsWith("image/")) return null;
    const src = record?.url ?? record?.src ?? record?.data ?? record?.source;
    if (!src) return null;
    if (record?.data && record?.mediaType && !String(record.data).startsWith("data:")) {
      return `data:${record.mediaType};base64,${record.data}`;
    }
    return src as string;
  };

  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Show
          when={renderMarkdown()}
          fallback={
            <div class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}>
              {"text" in p() ? (p() as { text: string }).text : ""}
            </div>
          }
        >
          <Show
            when={renderedMarkdown()}
            fallback={
              <div class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}>
                {"text" in p() ? (p() as { text: string }).text : ""}
              </div>
            }
          >
            <div
              class={`markdown-content max-w-none ${textClass()}
                [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4
                [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3
                [&_h3]:text-lg [&_h3]:font-bold [&_h3]:my-2
                [&_p]:my-3 [&_p]:leading-relaxed
                [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3
                [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3
                [&_li]:my-1
                [&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:italic
                [&_table]:w-full [&_table]:border-collapse [&_table]:my-4
                [&_th]:border [&_th]:border-gray-300 [&_th]:p-2 [&_th]:bg-gray-50
                [&_td]:border [&_td]:border-gray-300 [&_td]:p-2
              `.trim()}
              innerHTML={renderedMarkdown()!}
            />
          </Show>
        </Show>
      </Match>

      <Match when={p().type === "file"}>
        <Show when={fileInfo()}>
          {(info) => (
            <div
              class={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                tone() === "dark" ? "border-gray-6 bg-gray-1/60" : "border-gray-6/70 bg-gray-2/40"
              }`.trim()}
            >
              <div
                class={`h-9 w-9 rounded-lg flex items-center justify-center ${
                  tone() === "dark" ? "bg-gray-12/10 text-gray-12" : "bg-gray-2/70 text-gray-11"
                }`.trim()}
              >
                <File size={16} />
              </div>
              <div class="min-w-0 flex-1">
                <div class={`text-sm font-medium truncate ${textClass()}`.trim()}>{info().title}</div>
                <Show when={info().detail}>
                  <div class={`text-[11px] truncate ${subtleTextClass()}`.trim()}>{info().detail}</div>
                </Show>
              </div>
              <Show when={info().mime}>
                <div
                  class={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full max-w-[160px] truncate ${
                    tone() === "dark"
                      ? "bg-gray-12/10 text-gray-12/80"
                      : "bg-gray-1/70 text-gray-9"
                  }`.trim()}
                >
                  {info().mime}
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Match>

      <Match when={p().type === "reasoning"}>
        <Show
          when={
            showThinking() &&
            developerMode() &&
            "text" in p() &&
            typeof (p() as { text: string }).text === "string" &&
            (p() as { text: string }).text.trim()
          }
        >
          <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
            <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Thinking</summary>
            <pre class={`mt-2 whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
              {clampText(String((p() as { text: string }).text), 2000)}
            </pre>
          </details>
        </Show>
      </Match>

      <Match when={p().type === "tool"}>
        <Show when={toolOnly()}>
          <div class="grid gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="space-y-1">
                <div class={`text-xs font-medium text-gray-12`.trim()}>
                  {toolTitle()}
                </div>
                <div class={`text-[11px] ${subtleTextClass()}`.trim()}>{toolName()}</div>
              </div>
              <div
                class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  toolStatus() === "completed"
                    ? "bg-green-3/15 text-green-12"
                    : toolStatus() === "running"
                      ? "bg-blue-3/15 text-blue-12"
                      : toolStatus() === "error"
                        ? "bg-red-3/15 text-red-12"
                        : "bg-gray-2/10 text-gray-12"
                }`}
              >
                {toolStatus()}
              </div>
            </div>

            <Show when={toolSubtitle()}>
              <div class={`text-xs ${subtleTextClass()}`.trim()}>{toolSubtitle()}</div>
            </Show>

            <Show when={diagnostics().length > 0}>
              <div class={`rounded-lg border ${panelBgClass()} p-2`.trim()}>
                <div class={`text-[11px] font-medium ${subtleTextClass()}`.trim()}>Diagnostics</div>
                <div class="mt-2 grid gap-2">
                  <For each={diagnostics()}>
                    {(diag: any) => (
                      <div class="flex items-start justify-between gap-4 text-xs">
                        <div>
                          <div class="font-medium text-gray-12">{String(diag?.message ?? "")}</div>
                          <Show when={diag?.source || diag?.code}>
                            <div class="text-[11px] text-gray-10">
                              {[diag?.source, diag?.code].filter(Boolean).join(" · ")}
                            </div>
                          </Show>
                        </div>
                        <div class="text-[11px] text-gray-10 text-right">
                          <div>{formatDiagnosticLabel(diag)}</div>
                          <Show when={formatDiagnosticLocation(diag)}>
                            <div>{formatDiagnosticLocation(diag)}</div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={diffText()}>
              <div class={`rounded-lg border ${panelBgClass()} p-2`.trim()}>
                <div class={`text-[11px] font-medium ${subtleTextClass()}`.trim()}>Diff</div>
                <div class="mt-2 grid gap-1 rounded-md overflow-hidden">
                  <For each={diffLines()}>
                    {(line) => (
                      <div
                        class={`font-mono text-[11px] leading-relaxed px-2 py-0.5 whitespace-pre-wrap break-words ${diffLineClass(
                          line,
                        )}`.trim()}
                      >
                        {line || " "}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={toolImages().length > 0}>
              <div class="grid gap-2">
                <For each={toolImages()}>
                  {(image: any) => (
                    <img
                      src={image.src}
                      alt={image.alt || ""}
                      class="max-w-full h-auto rounded-lg border border-gray-6/50"
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={toolError()}>
              <div class="rounded-lg bg-red-1/40 p-2 text-xs text-red-12">
                {toolError()}
              </div>
            </Show>

            <Show when={showToolOutput() && toolOutput() && toolOutput() !== diffTextNormalized()}>
              <pre
                class={`whitespace-pre-wrap break-words rounded-lg ${panelBgClass()} p-2 text-xs text-gray-12`.trim()}
              >
                {outputPreview()}
              </pre>
            </Show>

            <Show when={showToolOutput() && isLargeOutput()}>
              <button
                class={`text-[11px] ${subtleTextClass()} hover:text-gray-12 transition-colors`}
                onClick={() => setExpandedOutput((current) => !current)}
              >
                {expandedOutput() ? "Show less" : "Show more"}
              </button>
            </Show>

            <Show when={showToolOutput() && toolInput() != null}>
              <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Input</summary>
                <pre class={`mt-2 whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
                  {safeStringify(toolInput())}
                </pre>
              </details>
            </Show>
          </div>
        </Show>
      </Match>

      <Match when={inlineImage()}>
        <img
          src={inlineImage()!}
          alt=""
          class="max-w-full h-auto rounded-xl border border-gray-6/50"
        />
      </Match>

      <Match when={p().type === "step-start" || p().type === "step-finish"}>
        <div class={`text-xs ${subtleTextClass()}`.trim()}>
          {p().type === "step-start" ? "Step started" : "Step finished"}
          <Show when={"reason" in p() && (p() as any).reason}>
            <span class={tone() === "dark" ? "text-gray-12/80" : "text-gray-11"}>
              {" "}· {String((p() as any).reason)}
            </span>
          </Show>
        </div>
      </Match>

      <Match when={true}>
        <Show when={developerMode()}>
          <pre class={`whitespace-pre-wrap break-words text-xs text-gray-12`.trim()}>
            {safeStringify(p())}
          </pre>
        </Show>
      </Match>
    </Switch>
  );
}

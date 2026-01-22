import { Match, Show, Switch, createMemo } from "solid-js";
import { marked } from "marked";
import type { Part } from "@opencode-ai/sdk/v2/client";
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

  const textClass = () => (tone() === "dark" ? "text-gray-12" : "text-gray-12");
  const subtleTextClass = () => (tone() === "dark" ? "text-gray-12/70" : "text-gray-11");
  const panelBgClass = () => (tone() === "dark" ? "bg-gray-2/10" : "bg-gray-2/30");
  const toolOnly = () => developerMode();
  const showToolOutput = () => developerMode();
  const renderedMarkdown = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return null;
    const text = "text" in p() ? String((p() as { text: string }).text ?? "") : "";
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
            <pre
              class={`mt-2 whitespace-pre-wrap break-words text-xs ${
                tone() === "dark" ? "text-gray-1" : "text-gray-12"
              }`.trim()}
            >
              {clampText(String((p() as { text: string }).text), 2000)}
            </pre>
          </details>
        </Show>
      </Match>

      <Match when={p().type === "tool"}>
        <Show when={toolOnly()}>
          <div class="grid gap-2">
            <div class="flex items-center justify-between gap-3">
              <div
                class={`text-xs font-medium ${tone() === "dark" ? "text-gray-1" : "text-gray-12"}`.trim()}
              >
                Tool · {("tool" in p() ? String((p() as { tool: string }).tool) : "unknown")}
              </div>
              <div
                class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  "state" in p() && (p() as any).state?.status === "completed"
                    ? "bg-green-3/15 text-green-12"
                    : "state" in p() && (p() as any).state?.status === "running"
                      ? "bg-blue-3/15 text-blue-12"
                      : "state" in p() && (p() as any).state?.status === "error"
                        ? "bg-red-3/15 text-red-12"
                        : "bg-gray-2/10 text-gray-1"
                }`}
              >
                {("state" in p() ? String((p() as any).state?.status ?? "unknown") : "unknown")}
              </div>
            </div>

            <Show when={"state" in p() && (p() as any).state?.title}>
              <div class={`text-xs ${subtleTextClass()}`.trim()}>{String((p() as any).state.title)}</div>
            </Show>

            <Show when={showToolOutput() && (p() as any).state?.output && typeof (p() as any).state.output === "string"}>
              <pre
                class={`whitespace-pre-wrap break-words rounded-lg ${panelBgClass()} p-2 text-xs ${
                  tone() === "dark" ? "text-gray-12" : "text-gray-1"
                }`.trim()}
              >
                {clampText(String((p() as any).state.output))}
              </pre>
            </Show>

            <Show when={showToolOutput() && (p() as any).state?.error && typeof (p() as any).state.error === "string"}>
              <div class="rounded-lg bg-red-1/40 p-2 text-xs text-red-12">
                {String((p() as any).state.error)}
              </div>
            </Show>

            <Show when={showToolOutput() && (p() as any).state?.input != null}>
              <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Input</summary>
                <pre
                  class={`mt-2 whitespace-pre-wrap break-words text-xs ${
                    tone() === "dark" ? "text-gray-12" : "text-gray-1"
                  }`.trim()}
                >
                  {safeStringify((p() as any).state.input)}
                </pre>
              </details>
            </Show>
          </div>
        </Show>
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
          <pre
            class={`whitespace-pre-wrap break-words text-xs ${
              tone() === "dark" ? "text-gray-12" : "text-gray-1"
            }`.trim()}
          >
            {safeStringify(p())}
          </pre>
        </Show>
      </Match>
    </Switch>
  );
}
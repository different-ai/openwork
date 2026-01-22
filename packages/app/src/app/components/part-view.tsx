import { For, Match, Show, Switch } from "solid-js";

import { t } from "../../i18n";
import type { Part } from "@opencode-ai/sdk/v2/client";

type Props = {
  part: Part;
  developerMode?: boolean;
  showThinking?: boolean;
  tone?: "light" | "dark";
  renderMarkdown?: boolean;
};

type MarkdownSegment =
  | { type: "text"; text: string }
  | { type: "code"; text: string; language: string };

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

function clampText(text: string, max = 800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated)`;
}

function parseMarkdownSegments(text: string): MarkdownSegment[] {
  if (!text.includes("```")) {
    return [{ type: "text", text }];
  }

  const segments: MarkdownSegment[] = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const language = match[1]?.trim() ?? "";
    const code = match[2]?.replace(/\n$/, "") ?? "";
    segments.push({ type: "code", text: code, language });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: "text", text }];
}

function parseInlineCode(text: string) {
  if (!text.includes("`")) return [{ type: "text", text }];
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return { type: "code", text: part.slice(1, -1) };
    }
    return { type: "text", text: part };
  });
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
  const inlineCodeClass = () =>
    tone() === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";
  const codeBlockClass = () =>
    tone() === "dark"
      ? "bg-gray-12/10 border-gray-11/20 text-gray-12"
      : "bg-gray-1/80 border-gray-6/70 text-gray-12";
  const toolOnly = () => developerMode();
  const showToolOutput = () => developerMode();

  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Show
          when={renderMarkdown()}
          fallback={
            <div class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}>{(p() as any).text}</div>
          }
        >
          <div class="space-y-3">
            <For each={parseMarkdownSegments(String((p() as any).text ?? ""))}>
              {(segment) =>
                segment.type === "code" ? (
                  <div class={`rounded-2xl border px-4 py-3 ${codeBlockClass()}`.trim()}>
                    <Show when={segment.language}>
                      <div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">
                        {segment.language}
                      </div>
                    </Show>
                    <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono">
                      {segment.text}
                    </pre>
                  </div>
                ) : (
                  <div class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}>
                    {parseInlineCode(segment.text).map((part) =>
                      part.type === "code" ? (
                        <code class={`rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass()}`.trim()}>
                          {part.text}
                        </code>
                      ) : (
                        part.text
                      ),
                    )}
                  </div>
                )
              }
            </For>
          </div>
        </Show>
      </Match>

      <Match when={p().type === "reasoning"}>
        <Show
          when={
            showThinking() &&
            developerMode() &&
            typeof (p() as any).text === "string" &&
            (p() as any).text.trim()
          }
        >
          <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
            <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>{t("part.thinking")}</summary>
            <pre
              class={`mt-2 whitespace-pre-wrap break-words text-xs ${
                tone() === "dark" ? "text-gray-1" : "text-gray-12"
              }`.trim()}
            >
              {clampText(String((p() as any).text), 2000)}
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
                {t("part.tool_label")} · {String((p() as any).tool)}
              </div>
              <div
                class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  (p() as any).state?.status === "completed"
                    ? "bg-green-3/15 text-green-12"
                    : (p() as any).state?.status === "running"
                      ? "bg-blue-3/15 text-blue-12"
                      : (p() as any).state?.status === "error"
                        ? "bg-red-3/15 text-red-12"
                        : "bg-gray-2/10 text-gray-1"
                }`}
              >
                {String((p() as any).state?.status ?? "unknown")}
              </div>
            </div>

            <Show when={(p() as any).state?.title}>
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
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>{t("part.input")}</summary>
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
          <Show when={(p() as any).reason}>
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

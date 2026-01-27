import { Match, Show, Switch } from "solid-js";

import type { Part } from "@opencode-ai/sdk/v2/client";
import { Sparkles } from "lucide-solid";
import { isSkillInvocation, extractSkillName } from "../app/utils";

type Props = {
  part: Part;
  developerMode?: boolean;
  showThinking?: boolean;
  tone?: "light" | "dark";
};

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

export default function PartView(props: Props) {
  const p = () => props.part;
  const developerMode = () => props.developerMode ?? false;
  const tone = () => props.tone ?? "light";
  const showThinking = () => props.showThinking ?? true;

  const textClass = () => (tone() === "dark" ? "text-black" : "text-zinc-200");
  const subtleTextClass = () => (tone() === "dark" ? "text-black/70" : "text-zinc-400");
  const panelBgClass = () => (tone() === "dark" ? "bg-black/10" : "bg-black/30");
  const toolOnly = () => developerMode();
  const showToolOutput = () => developerMode();

  return (
    <Switch>
      <Match when={p().type === "text"}>
        <div class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}>{(p() as any).text}</div>
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
            <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Thinking</summary>
            <pre
              class={`mt-2 whitespace-pre-wrap break-words text-xs ${
                tone() === "dark" ? "text-black" : "text-neutral-200"
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
              <div class="flex items-center gap-2">
                <div
                  class={`text-xs font-medium ${tone() === "dark" ? "text-black" : "text-neutral-200"}`.trim()}
                >
                  Tool · {String((p() as any).tool)}
                </div>
                <Show when={isSkillInvocation(p())}>
                  <span class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                    tone() === "dark" 
                      ? "bg-amber-500/20 text-amber-700 border-amber-500/30" 
                      : "bg-amber-500/20 text-amber-200 border-amber-500/30"
                  }`.trim()}>
                    <Sparkles size={10} />
                    Skill
                  </span>
                </Show>
              </div>
              <div
                class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  (p() as any).state?.status === "completed"
                    ? "bg-emerald-500/15 text-emerald-200"
                    : (p() as any).state?.status === "running"
                      ? "bg-blue-500/15 text-blue-200"
                      : (p() as any).state?.status === "error"
                        ? "bg-red-500/15 text-red-200"
                        : "bg-white/10 text-neutral-200"
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
                  tone() === "dark" ? "text-black" : "text-neutral-200"
                }`.trim()}
              >
                {clampText(String((p() as any).state.output))}
              </pre>
            </Show>

            <Show when={showToolOutput() && (p() as any).state?.error && typeof (p() as any).state.error === "string"}>
              <div class="rounded-lg bg-red-950/40 p-2 text-xs text-red-200">
                {String((p() as any).state.error)}
              </div>
            </Show>

            <Show when={showToolOutput() && (p() as any).state?.input != null}>
              <details class={`rounded-lg ${panelBgClass()} p-2`.trim()}>
                <summary class={`cursor-pointer text-xs ${subtleTextClass()}`.trim()}>Input</summary>
                <pre
                  class={`mt-2 whitespace-pre-wrap break-words text-xs ${
                    tone() === "dark" ? "text-black" : "text-neutral-200"
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
            <span class={tone() === "dark" ? "text-black/80" : "text-neutral-300"}>
              {" "}· {String((p() as any).reason)}
            </span>
          </Show>
        </div>
      </Match>

      <Match when={true}>
        <Show when={developerMode()}>
          <pre
            class={`whitespace-pre-wrap break-words text-xs ${
              tone() === "dark" ? "text-black" : "text-neutral-200"
            }`.trim()}
          >
            {safeStringify(p())}
          </pre>
        </Show>
      </Match>
    </Switch>
  );
}

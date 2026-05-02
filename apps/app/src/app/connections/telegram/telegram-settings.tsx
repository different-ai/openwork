import { createSignal, onMount, Show } from "solid-js";
import {
  telegramState,
  connectTelegram,
  disconnectTelegram,
  initTelegramStore,
} from "./telegram-store";

interface Props { workspacePath: string }

export function TelegramSettings(props: Props) {
  const [token, setToken] = createSignal("");
  const [show, setShow] = createSignal(false);

  onMount(() => initTelegramStore(props.workspacePath));

  const statusColor = () =>
    ({ connected: "text-green-500", connecting: "text-yellow-500",
       error: "text-red-500" } as Record<string, string>)[telegramState.status]
    ?? "text-zinc-400";

  const statusLabel = () =>
    ({ connected: "● Connected", connecting: "◌ Connecting…",
       error: "✕ Error", disabled: "○ Disabled", idle: "○ Not configured" }
    )[telegramState.status] ?? "○ Not configured";

  async function handleConnect() {
    const t = token().trim();
    if (!t) return;
    await connectTelegram(t, props.workspacePath);
    setToken("");
  }

  function copyUsername() {
    const u = telegramState.identity?.botUsername;
    if (u) navigator.clipboard.writeText(`@${u}`);
  }

  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4">
      <div class="flex items-center justify-between">
        <span class="font-medium text-zinc-100">Telegram Bot</span>
        <span class={`text-sm ${statusColor()}`}>{statusLabel()}</span>
      </div>

      <Show when={telegramState.status === "error"}>
        <div class="rounded bg-red-950 border border-red-800 px-3 py-2 text-sm text-red-300">
          {telegramState.errorMessage}
        </div>
      </Show>

      <Show when={telegramState.status === "connected" && telegramState.identity}>
        <Show when={telegramState.identity?.botUsername}>
          <div class="flex items-center justify-between text-sm">
            <span class="text-zinc-400">Bot</span>
            <div class="flex items-center gap-2">
              <span class="text-zinc-100 font-mono">@{telegramState.identity!.botUsername}</span>
              <button onClick={copyUsername}
                class="text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-700 rounded px-2 py-0.5">
                Copy
              </button>
            </div>
          </div>
        </Show>
        <button onClick={() => disconnectTelegram(props.workspacePath)}
          class="w-full rounded-md border border-red-800 bg-red-950 hover:bg-red-900 text-red-300 text-sm py-1.5 transition-colors">
          Disconnect
        </button>
      </Show>

      <Show when={telegramState.status !== "connected"}>
        <p class="text-xs text-zinc-400">
          Get a token from <a href="https://t.me/BotFather" target="_blank" class="text-blue-400 hover:underline">@BotFather</a>
        </p>
        <div class="relative">
          <input
            type={show() ? "text" : "password"}
            placeholder="123456:ABC-DEF..."
            value={token()}
            onInput={e => setToken(e.currentTarget.value)}
            class="w-full rounded-md bg-zinc-800 border border-zinc-700 focus:border-blue-500 focus:outline-none px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 pr-16"
          />
          <button onClick={() => setShow(!show())}
            class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300">
            {show() ? "Hide" : "Show"}
          </button>
        </div>
        <button onClick={handleConnect}
          disabled={!token().trim() || telegramState.status === "connecting"}
          class="w-full rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm py-1.5 font-medium transition-colors">
          {telegramState.status === "connecting" ? "Connecting…" : "Connect"}
        </button>
      </Show>
    </div>
  );
}

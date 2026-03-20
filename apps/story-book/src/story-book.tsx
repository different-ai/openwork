import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Component } from "solid-js";
import {
  ArrowRight,
  Bot,
  Check,
  Cloud,
  Command,
  Compass,
  FolderOpen,
  Layers3,
  Moon,
  Paperclip,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  Workflow,
  Wrench,
} from "lucide-solid";

import Button from "../../app/src/app/components/button";
import Card from "../../app/src/app/components/card";
import OpenWorkLogo from "../../app/src/app/components/openwork-logo";
import StatusBar from "../../app/src/app/components/status-bar";
import TextInput from "../../app/src/app/components/text-input";
import WorkspaceChip from "../../app/src/app/components/workspace-chip";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "../../app/src/app/theme";
import type { McpStatusMap } from "../../app/src/app/types";
import {
  artifactItems,
  onboardingChoices,
  progressItems,
  screenCopy,
  sessionList,
  sessionMessages,
  settingsCards,
  settingsTabs,
  storyWorkspaces,
  type StoryScreen,
  type StoryStep,
} from "./mock-data";

const SCREENS = ["session", "settings", "components", "onboarding"] as const satisfies readonly StoryScreen[];

const themeModes: ThemeMode[] = ["system", "light", "dark"];

const mcpStatuses: McpStatusMap = {
  browser: { status: "connected" },
  notion: { status: "connected" },
};

function resolveScreen(): StoryScreen {
  if (typeof window === "undefined") return "session";
  const raw = window.location.hash.replace(/^#/, "").trim();
  return SCREENS.includes(raw as StoryScreen) ? (raw as StoryScreen) : "session";
}

const SectionFrame: Component<{ title: string; detail: string; aside?: string; children: any }> = (props) => (
  <section class="overflow-hidden rounded-[32px] border border-white/70 bg-white/82 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.25)] backdrop-blur-xl">
    <div class="border-b border-dls-border/80 bg-white/70 px-6 py-5 md:px-8">
      <div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div class="text-[11px] font-semibold uppercase tracking-[0.22em] text-dls-secondary">OpenWork story</div>
          <h2 class="mt-1 text-xl font-semibold tracking-tight text-dls-text md:text-2xl">{props.title}</h2>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-dls-secondary">{props.detail}</p>
        </div>
        <Show when={props.aside}>
          <div class="rounded-full border border-dls-border bg-white/90 px-3 py-1 text-[11px] font-medium text-dls-secondary">
            {props.aside}
          </div>
        </Show>
      </div>
    </div>
    <div class="p-4 md:p-6">{props.children}</div>
  </section>
);

const StoryPill: Component<{
  active?: boolean;
  onClick?: () => void;
  children: any;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
      props.active
        ? "border-dls-accent bg-dls-accent text-white"
        : "border-dls-border bg-white/90 text-dls-secondary hover:border-gray-6 hover:text-dls-text"
    }`}
  >
    {props.children}
  </button>
);

function StoryStepRow(props: { step: StoryStep }) {
  const accent = () => {
    if (props.step.state === "done") return "border-emerald-7 bg-emerald-3 text-emerald-11";
    if (props.step.state === "active") return "border-blue-7 bg-blue-3 text-blue-11";
    return "border-gray-6 bg-gray-3 text-gray-10";
  };

  return (
    <div class="flex items-start gap-3 rounded-2xl border border-gray-6/50 bg-white/92 px-4 py-3 shadow-[0_10px_24px_-20px_rgba(15,23,42,0.3)]">
      <div class={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${accent()}`}>
        <Show when={props.step.state === "done"} fallback={<span>{props.step.state === "active" ? "~" : "-"}</span>}>
          <Check size={13} />
        </Show>
      </div>
      <div class="min-w-0">
        <div class="text-sm font-medium text-dls-text">{props.step.label}</div>
        <div class="mt-1 text-xs leading-5 text-dls-secondary">{props.step.detail}</div>
      </div>
    </div>
  );
}

function SessionShellStory() {
  return (
    <SectionFrame
      title={screenCopy.session.title}
      detail={screenCopy.session.detail}
      aside="Mocked workspaces + timeline + utility rail"
    >
      <div class="overflow-hidden rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div class="flex min-h-[860px] bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.98))]">
          <aside class="hidden w-[286px] shrink-0 flex-col border-r border-dls-border bg-[linear-gradient(180deg,rgba(249,250,251,0.98),rgba(244,246,248,0.95))] xl:flex">
            <div class="flex items-center justify-between border-b border-dls-border px-4 py-4">
              <div>
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Worker rail</div>
                <div class="mt-1 text-sm font-semibold text-dls-text">Current workspaces</div>
              </div>
              <Button variant="outline" class="h-9 rounded-xl px-3 text-xs">
                <span class="inline-flex items-center gap-1">
                  <Compass size={13} /> Add
                </span>
              </Button>
            </div>

            <div class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <WorkspaceChip workspace={storyWorkspaces[0]} onClick={() => undefined} />
              <WorkspaceChip workspace={storyWorkspaces[1]} onClick={() => undefined} connecting />

              <div class="rounded-[24px] border border-gray-6/50 bg-white/90 p-3 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.28)]">
                <div class="flex items-center justify-between gap-2 px-1 pb-2">
                  <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Today</div>
                  <span class="text-[11px] text-dls-secondary">4 sessions</span>
                </div>
                <div class="space-y-1.5">
                  <For each={sessionList}>
                    {(session) => (
                      <button
                        type="button"
                        class={`flex w-full items-start justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${
                          session.active ? "bg-gray-12 text-white shadow-[0_12px_24px_-20px_rgba(17,24,39,0.5)]" : "hover:bg-gray-3 text-dls-text"
                        }`}
                      >
                        <div class="min-w-0">
                          <div class="truncate text-sm font-medium">{session.title}</div>
                          <div class={`mt-1 text-[11px] ${session.active ? "text-white/70" : "text-dls-secondary"}`}>{session.meta}</div>
                        </div>
                        <ArrowRight size={14} class={session.active ? "text-white/70" : "text-dls-secondary"} />
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="rounded-[24px] border border-gray-6/50 bg-gray-2/40 p-4">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-sm font-semibold text-dls-text">Progress</div>
                  <span class="rounded-full bg-white px-2 py-1 text-[11px] text-dls-secondary">2 / 4 done</span>
                </div>
                <div class="mt-3 space-y-2.5">
                  <For each={progressItems}>
                    {(item) => (
                      <div class="flex items-center gap-2 text-sm text-dls-text">
                        <span
                          class={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${
                            item.done ? "border-emerald-7 bg-emerald-3 text-emerald-11" : "border-gray-6 bg-white text-dls-secondary"
                          }`}
                        >
                          <Show when={item.done} fallback={<span class="text-[10px]">-</span>}>
                            <Check size={12} />
                          </Show>
                        </span>
                        <span>{item.label}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </aside>

          <div class="flex min-w-0 flex-1 flex-col">
            <header class="border-b border-dls-border bg-white/88 px-5 py-4 backdrop-blur md:px-6">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">
                    <span class="inline-flex items-center gap-1 rounded-full border border-gray-6 bg-gray-2 px-2 py-1">
                      <Workflow size={12} /> Session
                    </span>
                    <span class="hidden md:inline">Local Foundation</span>
                  </div>
                  <h3 class="mt-2 truncate text-lg font-semibold text-dls-text md:text-xl">
                    Recreate the OpenWork core components in story-book
                  </h3>
                  <p class="mt-1 max-w-3xl text-sm text-dls-secondary">
                    Dense but calm control surfaces with a focused reading column, strong task framing, and a persistent action footer.
                  </p>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <StoryPill>
                    <span class="inline-flex items-center gap-1.5">
                      <Search size={12} /> Search
                    </span>
                  </StoryPill>
                  <StoryPill>
                    <span class="inline-flex items-center gap-1.5">
                      <Layers3 size={12} /> Context
                    </span>
                  </StoryPill>
                  <StoryPill active>
                    <span class="inline-flex items-center gap-1.5">
                      <Sparkles size={12} /> Design mode
                    </span>
                  </StoryPill>
                </div>
              </div>
            </header>

            <div class="flex min-h-0 flex-1">
              <div class="flex min-w-0 flex-1 flex-col">
                <div class="flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
                  <For each={sessionMessages}>
                    {(message) => (
                      <div class={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          class={`max-w-3xl rounded-[28px] border px-5 py-4 shadow-[0_18px_44px_-30px_rgba(15,23,42,0.28)] ${
                            message.role === "user"
                              ? "border-gray-12 bg-gray-12 text-white"
                              : "border-gray-6/60 bg-white/96 text-dls-text"
                          }`}
                        >
                          <div class="flex flex-wrap items-center gap-2">
                            <div
                              class={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                                message.role === "user" ? "bg-white/12 text-white/80" : "bg-gray-2 text-dls-secondary"
                              }`}
                            >
                              {message.title}
                            </div>
                            <div class={`text-xs ${message.role === "user" ? "text-white/70" : "text-dls-secondary"}`}>
                              {message.detail}
                            </div>
                          </div>

                          <div class="mt-3 space-y-3 text-sm leading-6">
                            <For each={message.body}>{(paragraph) => <p>{paragraph}</p>}</For>
                          </div>

                          <Show when={message.steps?.length}>
                            <div class="mt-4 space-y-2">
                              <For each={message.steps}>{(step) => <StoryStepRow step={step} />}</For>
                            </div>
                          </Show>

                          <Show when={message.tags?.length}>
                            <div class="mt-4 flex flex-wrap gap-2">
                              <For each={message.tags}>
                                {(tag) => (
                                  <span
                                    class={`rounded-full px-2.5 py-1 text-[11px] ${
                                      message.role === "user"
                                        ? "border border-white/15 bg-white/8 text-white/80"
                                        : "border border-gray-6 bg-gray-2 text-dls-secondary"
                                    }`}
                                  >
                                    {tag}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>

                <div class="border-t border-dls-border bg-white/92 px-4 py-4 md:px-6">
                  <div class="rounded-[28px] border border-gray-6/60 bg-gray-1/90 p-4 shadow-[0_20px_48px_-30px_rgba(15,23,42,0.32)]">
                    <div class="mb-3 flex flex-wrap gap-2">
                      <span class="inline-flex items-center gap-1 rounded-full border border-gray-6 bg-white px-3 py-1 text-[11px] text-dls-secondary">
                        <Command size={11} /> /design-review
                      </span>
                      <span class="inline-flex items-center gap-1 rounded-full border border-gray-6 bg-white px-3 py-1 text-[11px] text-dls-secondary">
                        <Bot size={11} /> @openwork
                      </span>
                      <span class="inline-flex items-center gap-1 rounded-full border border-gray-6 bg-white px-3 py-1 text-[11px] text-dls-secondary">
                        <Paperclip size={11} /> 3 references
                      </span>
                    </div>

                    <div class="min-h-[112px] rounded-[24px] border border-gray-6/60 bg-white px-4 py-4 text-sm leading-6 text-dls-text">
                      Build a design-first story-book with mocked workspaces, a realistic session feed, reusable shell cards, and onboarding states that mirror the current OpenWork app.
                    </div>

                    <div class="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div class="flex flex-wrap gap-2">
                        <StoryPill>
                          Claude Sonnet 4
                        </StoryPill>
                        <StoryPill>
                          Reasoning: medium
                        </StoryPill>
                        <StoryPill>
                          Local Foundation
                        </StoryPill>
                      </div>

                      <div class="flex items-center gap-2">
                        <Button variant="ghost" class="rounded-full px-4">
                          Attach reference
                        </Button>
                        <Button class="rounded-full px-5">
                          <span class="inline-flex items-center gap-2">
                            Send <Send size={14} />
                          </span>
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <aside class="hidden w-[320px] shrink-0 border-l border-dls-border bg-[linear-gradient(180deg,rgba(249,250,251,0.98),rgba(244,246,248,0.96))] xl:flex xl:flex-col">
                <div class="border-b border-dls-border px-5 py-4">
                  <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Utility rail</div>
                  <div class="mt-1 text-sm font-semibold text-dls-text">Artifacts + context</div>
                </div>
                <div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                  <div class="rounded-[24px] border border-gray-6/50 bg-white/94 p-4">
                    <div class="flex items-center justify-between gap-2">
                      <div class="text-sm font-semibold text-dls-text">Artifacts</div>
                      <span class="rounded-full bg-gray-2 px-2 py-1 text-[11px] text-dls-secondary">4 items</span>
                    </div>
                    <div class="mt-3 space-y-2">
                      <For each={artifactItems}>
                        {(item) => (
                          <div class="rounded-2xl border border-gray-6/40 bg-gray-1/60 px-3 py-3">
                            <div class="text-sm font-medium text-dls-text">{item.title}</div>
                            <div class="mt-1 text-xs leading-5 text-dls-secondary">{item.detail}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>

                  <div class="rounded-[24px] border border-gray-6/50 bg-white/94 p-4">
                    <div class="text-sm font-semibold text-dls-text">Connection state</div>
                    <div class="mt-3 grid gap-3">
                      <div class="rounded-2xl border border-emerald-7/30 bg-emerald-3/60 px-3 py-3">
                        <div class="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-11">Runtime</div>
                        <div class="mt-1 text-sm text-emerald-12">Healthy local engine + connected worker proxy.</div>
                      </div>
                      <div class="rounded-2xl border border-blue-7/30 bg-blue-3/50 px-3 py-3">
                        <div class="text-xs font-semibold uppercase tracking-[0.16em] text-blue-11">Design note</div>
                        <div class="mt-1 text-sm text-blue-12">Use this rail to test empty, syncing, and actionable detail states.</div>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-[24px] border border-gray-6/50 bg-white/94 p-4">
                    <div class="text-sm font-semibold text-dls-text">Quick actions</div>
                    <div class="mt-3 grid grid-cols-2 gap-2">
                      <Button variant="outline" class="justify-start rounded-2xl px-3 py-3 text-xs">
                        <FolderOpen size={14} /> Inbox
                      </Button>
                      <Button variant="outline" class="justify-start rounded-2xl px-3 py-3 text-xs">
                        <Cloud size={14} /> Worker
                      </Button>
                      <Button variant="outline" class="justify-start rounded-2xl px-3 py-3 text-xs">
                        <Wrench size={14} /> Tools
                      </Button>
                      <Button variant="outline" class="justify-start rounded-2xl px-3 py-3 text-xs">
                        <Settings size={14} /> Settings
                      </Button>
                    </div>
                  </div>
                </div>
              </aside>
            </div>

            <StatusBar
              clientConnected
              openworkServerStatus="connected"
              developerMode
              settingsOpen={false}
              onSendFeedback={() => undefined}
              onOpenSettings={() => undefined}
              onOpenMessaging={() => undefined}
              onOpenProviders={() => undefined}
              onOpenMcp={() => undefined}
              providerConnectedIds={["anthropic", "openai"]}
              mcpStatuses={mcpStatuses}
              statusLabel="Story ready"
              statusDetail="Mocked data · core shell recreation · no live backend required"
            />
          </div>
        </div>
      </div>
    </SectionFrame>
  );
}

function SettingsStory() {
  return (
    <SectionFrame
      title={screenCopy.settings.title}
      detail={screenCopy.settings.detail}
      aside="Operational cards, not generic settings forms"
    >
      <div class="overflow-hidden rounded-[28px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div class="border-b border-dls-border bg-white/88 px-5 py-4 md:px-6">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Worker</div>
              <div class="mt-1 text-lg font-semibold text-dls-text">Settings</div>
            </div>
            <div class="flex flex-wrap gap-2">
              <For each={settingsTabs}>
                {(tab, index) => <StoryPill active={index() === 0}>{tab}</StoryPill>}
              </For>
            </div>
          </div>
        </div>

        <div class="grid gap-4 bg-[linear-gradient(180deg,rgba(248,250,252,0.9),rgba(255,255,255,0.98))] p-4 md:grid-cols-2 md:p-6 xl:grid-cols-3">
          <For each={settingsCards}>
            {(card) => (
              <div class="rounded-[24px] border border-gray-6/50 bg-gray-2/30 p-5 shadow-[0_20px_45px_-34px_rgba(15,23,42,0.35)]">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">{card.eyebrow}</div>
                <div class="mt-2 flex items-center justify-between gap-3">
                  <h3 class="text-base font-semibold text-dls-text">{card.title}</h3>
                  <span class="rounded-full border border-gray-6 bg-white/90 px-2 py-1 text-[11px] text-dls-secondary">Live</span>
                </div>
                <p class="mt-3 text-sm leading-6 text-dls-secondary">{card.body}</p>
                <ul class="mt-4 space-y-2">
                  <For each={card.points}>
                    {(point) => (
                      <li class="flex items-start gap-2 text-sm text-dls-text">
                        <span class="mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-12 text-white">
                          <Check size={12} />
                        </span>
                        <span>{point}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <div class="mt-5">
                  <Button variant="outline" class="rounded-full px-4 text-xs">
                    {card.action}
                  </Button>
                </div>
              </div>
            )}
          </For>

          <div class="rounded-[24px] border border-gray-6/50 bg-gray-2/30 p-5 shadow-[0_20px_45px_-34px_rgba(15,23,42,0.35)] xl:col-span-2">
            <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Connection details</div>
            <div class="mt-2 text-base font-semibold text-dls-text">Remote worker handoff</div>
            <div class="mt-4 grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
              <div class="space-y-4">
                <TextInput label="OpenWork URL" value="https://worker.openworklabs.com" hint="Used when the app connects through the worker proxy." />
                <TextInput label="Workspace directory" value="/srv/openwork/app-shell" hint="Visible context path for the remote session." />
                <div class="flex flex-wrap gap-2">
                  <Button class="rounded-full px-4 text-xs">Reconnect worker</Button>
                  <Button variant="outline" class="rounded-full px-4 text-xs">Copy token</Button>
                </div>
              </div>
              <div class="rounded-[24px] border border-blue-7/30 bg-blue-3/45 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-11">Design principles</div>
                <div class="mt-3 space-y-2 text-sm leading-6 text-blue-12">
                  <p>Runtime cards should feel dense and trustworthy, not airy dashboard widgets.</p>
                  <p>Separate destructive actions with border + spacing instead of heavy red chrome.</p>
                  <p>Connection copy should stay concrete: URL, token state, last heartbeat, next action.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SectionFrame>
  );
}

function ComponentsStory() {
  return (
    <SectionFrame
      title={screenCopy.components.title}
      detail={screenCopy.components.detail}
      aside="Live primitives imported from apps/app"
    >
      <div class="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card
          title="Buttons"
          actions={<span class="text-xs text-dls-secondary">Actual app component</span>}
        >
          <div class="flex flex-wrap gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </div>
          <div class="mt-4 text-sm text-dls-secondary">
            Core actions stay compact and operational; no oversized marketing buttons inside the app shell.
          </div>
        </Card>

        <Card title="Text inputs" actions={<span class="text-xs text-dls-secondary">Actual app component</span>}>
          <div class="space-y-4">
            <TextInput label="Worker URL" value="https://worker.openworklabs.com" hint="Remote OpenWork host used for shared execution." />
            <TextInput label="Display name" value="OpenWork App Shell" hint="Shown in the worker rail and session breadcrumbs." />
          </div>
        </Card>

        <Card title="Workspace chips" actions={<span class="text-xs text-dls-secondary">Actual app component</span>}>
          <div class="flex flex-wrap gap-3">
            <WorkspaceChip workspace={storyWorkspaces[0]} onClick={() => undefined} />
            <WorkspaceChip workspace={storyWorkspaces[1]} onClick={() => undefined} connecting />
          </div>
        </Card>

        <Card title="Surface recipes" actions={<span class="text-xs text-dls-secondary">Recreated for story-book</span>}>
          <div class="grid gap-3 md:grid-cols-2">
            <div class="rounded-[24px] border border-gray-6/50 bg-gray-2/35 p-4">
              <div class="text-sm font-semibold text-dls-text">Shell card</div>
              <div class="mt-2 text-sm leading-6 text-dls-secondary">Use for runtime status, provider groups, and connected worker summaries.</div>
            </div>
            <div class="rounded-[24px] border border-gray-6/40 bg-white/95 p-4 shadow-[0_12px_28px_-24px_rgba(15,23,42,0.4)]">
              <div class="text-sm font-semibold text-dls-text">Readable panel</div>
              <div class="mt-2 text-sm leading-6 text-dls-secondary">Use for transcript moments, onboarding explanations, and detailed inspection surfaces.</div>
            </div>
          </div>
        </Card>

        <div class="xl:col-span-2">
          <div class="overflow-hidden rounded-[28px] border border-dls-border bg-white shadow-[var(--dls-shell-shadow)]">
            <div class="border-b border-dls-border px-5 py-4">
              <div class="text-sm font-semibold text-dls-text">Status rail</div>
              <div class="mt-1 text-sm text-dls-secondary">Actual app footer component with mocked provider and MCP state.</div>
            </div>
            <StatusBar
              clientConnected
              openworkServerStatus="connected"
              developerMode={false}
              settingsOpen={false}
              onSendFeedback={() => undefined}
              onOpenSettings={() => undefined}
              onOpenMessaging={() => undefined}
              onOpenProviders={() => undefined}
              onOpenMcp={() => undefined}
              providerConnectedIds={["anthropic", "openai", "groq"]}
              mcpStatuses={mcpStatuses}
            />
          </div>
        </div>
      </div>
    </SectionFrame>
  );
}

function OnboardingStory() {
  return (
    <SectionFrame
      title={screenCopy.onboarding.title}
      detail={screenCopy.onboarding.detail}
      aside="Calm first-run canvas, not a dead-end setup wizard"
    >
      <div class="relative overflow-hidden rounded-[30px] border border-dls-border bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,1))] px-6 py-10 shadow-[var(--dls-shell-shadow)] md:px-10">
        <div class="absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_58%)]" />
        <div class="relative mx-auto max-w-4xl">
          <div class="mx-auto max-w-xl text-center">
            <OpenWorkLogo size={56} class="mx-auto" />
            <div class="mt-5 text-[11px] font-semibold uppercase tracking-[0.24em] text-dls-secondary">OpenWork onboarding</div>
            <h2 class="mt-3 text-3xl font-semibold tracking-tight text-dls-text md:text-4xl">
              Create your first workspace or connect a remote worker.
            </h2>
            <p class="mt-4 text-sm leading-7 text-dls-secondary md:text-base">
              The first-run flow should feel composed and trustworthy: enough guidance to orient a new user, without breaking the premium operational tone of the app.
            </p>
          </div>

          <div class="mt-8 flex flex-wrap justify-center gap-2">
            <For each={themeModes}>
              {(mode) => (
                <StoryPill>
                  <span class="inline-flex items-center gap-1.5">
                    <Show when={mode === "light"} fallback={<Show when={mode === "dark"} fallback={<Settings size={12} />}><Moon size={12} /></Show>}>
                      <Sun size={12} />
                    </Show>
                    {mode}
                  </span>
                </StoryPill>
              )}
            </For>
          </div>

          <div class="mt-10 grid gap-4 lg:grid-cols-2">
            <For each={onboardingChoices}>
              {(choice, index) => (
                <div class="rounded-[28px] border border-gray-6/50 bg-white/94 p-6 shadow-[0_20px_48px_-32px_rgba(15,23,42,0.32)]">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">
                      {index() === 0 ? "Local-first" : "Remote-ready"}
                    </div>
                    <span class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gray-12 text-white">
                      {index() === 0 ? <FolderOpen size={18} /> : <Cloud size={18} />}
                    </span>
                  </div>
                  <h3 class="mt-4 text-xl font-semibold text-dls-text">{choice.title}</h3>
                  <p class="mt-3 text-sm leading-6 text-dls-secondary">{choice.detail}</p>
                  <div class="mt-6 flex gap-2">
                    <Button class="rounded-full px-5">Continue</Button>
                    <Button variant="outline" class="rounded-full px-5">Preview flow</Button>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="mt-8 rounded-[28px] border border-gray-6/50 bg-gray-2/35 p-5 md:p-6">
            <div class="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
              <div class="space-y-4">
                <TextInput label="Suggested workspace path" value="~/OpenWork/OpenWork App" hint="This path should feel editable and trustworthy, not hidden behind magic defaults." />
                <div class="flex flex-wrap gap-2 text-xs text-dls-secondary">
                  <span class="rounded-full border border-gray-6 bg-white px-3 py-1">Starter automations</span>
                  <span class="rounded-full border border-gray-6 bg-white px-3 py-1">Shared worker connect</span>
                  <span class="rounded-full border border-gray-6 bg-white px-3 py-1">Theme remembered</span>
                </div>
              </div>
              <Button variant="outline" class="rounded-full px-5">Pick folder</Button>
            </div>
          </div>
        </div>
      </div>
    </SectionFrame>
  );
}

export default function StoryBookApp() {
  const [screen, setScreen] = createSignal<StoryScreen>(resolveScreen());
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  createEffect(() => {
    const mode = themeMode();
    persistThemeMode(mode);
    applyThemeMode(mode);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const target = `#${screen()}`;
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    document.title = `OpenWork Story Book — ${screenCopy[screen()].title}`;
  });

  createEffect(() => {
    if (typeof window === "undefined") return;

    const syncFromHash = () => setScreen(resolveScreen());
    window.addEventListener("hashchange", syncFromHash);

    const unsubscribeSystemTheme = subscribeToSystemTheme(() => {
      if (themeMode() === "system") {
        applyThemeMode("system");
      }
    });

    onCleanup(() => {
      window.removeEventListener("hashchange", syncFromHash);
      unsubscribeSystemTheme();
    });
  });

  const currentCopy = createMemo(() => screenCopy[screen()]);

  return (
    <div class="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.1),transparent_28%),radial-gradient(circle_at_top_right,rgba(249,115,22,0.08),transparent_24%),linear-gradient(180deg,#f6f9fc_0%,#ffffff_72%)] text-dls-text">
      <div class="mx-auto flex max-w-[1640px] flex-col gap-6 px-4 py-6 md:px-6 xl:px-8">
        <section class="overflow-hidden rounded-[34px] border border-white/80 bg-white/78 shadow-[0_32px_90px_-34px_rgba(15,23,42,0.3)] backdrop-blur-xl">
          <div class="grid gap-6 px-6 py-6 md:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <div class="flex items-center gap-3">
                <div class="rounded-[20px] border border-dls-border bg-white p-3 shadow-[0_14px_32px_-24px_rgba(15,23,42,0.28)]">
                  <OpenWorkLogo size={28} />
                </div>
                <div>
                  <div class="text-[11px] font-semibold uppercase tracking-[0.24em] text-dls-secondary">OpenWork design lab</div>
                  <h1 class="mt-1 text-2xl font-semibold tracking-tight text-dls-text md:text-3xl">OpenWork story-book</h1>
                </div>
              </div>

              <p class="mt-5 max-w-3xl text-sm leading-7 text-dls-secondary md:text-base">
                A design-first recreation of the app’s core components and core screens. It keeps the live visual language from <code>apps/app</code>, but swaps runtime behavior for mocked design states that are easy to iterate on.
              </p>

              <div class="mt-5 flex flex-wrap gap-2">
                <For each={SCREENS}>
                  {(item) => (
                    <StoryPill active={screen() === item} onClick={() => setScreen(item)}>
                      {screenCopy[item].title}
                    </StoryPill>
                  )}
                </For>
              </div>
            </div>

            <div class="grid gap-3 md:grid-cols-3">
              <div class="rounded-[26px] border border-gray-6/50 bg-white/94 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Now showing</div>
                <div class="mt-2 text-base font-semibold text-dls-text">{currentCopy().title}</div>
                <div class="mt-2 text-sm leading-6 text-dls-secondary">{currentCopy().detail}</div>
              </div>
              <div class="rounded-[26px] border border-gray-6/50 bg-white/94 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Theme</div>
                <div class="mt-3 flex flex-wrap gap-2">
                  <For each={themeModes}>
                    {(mode) => (
                      <StoryPill active={themeMode() === mode} onClick={() => setThemeMode(mode)}>
                        <span class="inline-flex items-center gap-1.5 capitalize">
                          <Show when={mode === "light"} fallback={<Show when={mode === "dark"} fallback={<Settings size={12} />}><Moon size={12} /></Show>}>
                            <Sun size={12} />
                          </Show>
                          {mode}
                        </span>
                      </StoryPill>
                    )}
                  </For>
                </div>
              </div>
              <div class="rounded-[26px] border border-gray-6/50 bg-white/94 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dls-secondary">Shared foundation</div>
                <div class="mt-3 space-y-2 text-sm text-dls-text">
                  <div class="flex items-center gap-2"><Check size={14} class="text-emerald-10" /> tokens from <code>apps/app</code></div>
                  <div class="flex items-center gap-2"><Check size={14} class="text-emerald-10" /> live primitives reused</div>
                  <div class="flex items-center gap-2"><Check size={14} class="text-emerald-10" /> mocked screen states</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <Switch>
          <Match when={screen() === "session"}>
            <SessionShellStory />
          </Match>
          <Match when={screen() === "settings"}>
            <SettingsStory />
          </Match>
          <Match when={screen() === "components"}>
            <ComponentsStory />
          </Match>
          <Match when={screen() === "onboarding"}>
            <OnboardingStory />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

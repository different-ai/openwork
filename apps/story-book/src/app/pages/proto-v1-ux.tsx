import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import {
  ArrowUp,
  BookOpen,
  Box,
  Brain,
  Calendar,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileCode,
  FileText,
  Gamepad2,
  History,
  Layout,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Terminal,
  TrendingUp,
  Trophy,
  X,
  Zap,
  Clock,
} from "lucide-solid";

type TabKey = "new-thread" | "automations" | "skills";

const navTabs: Array<{ id: TabKey; label: string; icon: any }> = [
  { id: "new-thread", label: "New thread", icon: Plus },
  { id: "automations", label: "Automations", icon: History },
  { id: "skills", label: "Skills", icon: Zap },
];

const threadItems = [
  { text: "my packages/web/src/app/(auth...", time: "3mo" },
  { text: "could you look at https://github...", time: "3mo" },
  { text: "<user_action> <context>User ini...", time: "3mo" },
  { text: "'/Users/benjaminshafii/Download...", time: "4mo" },
  { text: "could you review the current bra...", time: "4mo" },
  { text: "it seems there's an issue with th...", time: "4mo" },
];

const automationTemplates = [
  { icon: Calendar, description: "Scan recent commits and flag riskier diffs.", color: "text-red-9" },
  { icon: BookOpen, description: "Draft weekly release notes from merged PRs.", color: "text-blue-9" },
  { icon: MessageSquare, description: "Summarize yesterday's git activity by repo.", color: "text-purple-9" },
  { icon: TrendingUp, description: "Watch CI failures and surface recurring flakes.", color: "text-indigo-9" },
  { icon: Trophy, description: "Build a tiny classic game for a team demo.", color: "text-amber-9" },
  { icon: Brain, description: "Suggest the next skills to install for this worker.", color: "text-pink-9" },
];

const skillInstalled = [
  {
    icon: Sparkles,
    title: "Remotion Best Practices",
    description: "Best practices for Remotion - Video creation in React",
    badge: "zerofinance",
  },
  {
    icon: Pencil,
    title: "Skill Creator",
    description: "Create or update a skill",
  },
  {
    icon: Layout,
    title: "Skill Installer",
    description: "Install curated skills from openai/skills or other repos",
  },
];

const skillRecommended = [
  {
    icon: ExternalLink,
    title: "Atlas",
    description: "Manage tabs in ChatGPT Atlas and access your...",
  },
  {
    icon: Gamepad2,
    title: "Develop Web Game",
    description: "Web game dev + Playwright test loop",
  },
  {
    icon: FileCode,
    title: "Doc",
    description: "Edit and review docx files",
  },
];

const promptSuggestions = [
  {
    icon: Gamepad2,
    description: "Build a classic Snake game in this repo.",
    color: "text-blue-9",
  },
  {
    icon: FileText,
    description: "Create a one-page $pdf that summarizes this app.",
    color: "text-purple-9",
  },
  {
    icon: Layout,
    description: "Summarize last week's PRs by teammate and theme.",
    color: "text-sky-9",
  },
];

const SidebarItem = (props: {
  icon: any;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) => {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
        props.active
          ? "bg-gray-3 text-gray-12"
          : "text-gray-10 hover:bg-gray-2 hover:text-gray-12"
      }`}
    >
      <Icon size={18} class="text-current" />
      <span>{props.label}</span>
    </button>
  );
};

const ThreadItem = (props: { text: string; time: string }) => (
  <div class="group relative flex items-center justify-between rounded-xl px-3 py-2 transition-colors hover:bg-gray-2">
    <span class="truncate text-sm font-medium text-gray-11 group-hover:text-gray-12">
      {props.text}
    </span>
    <span class="text-xs text-gray-8">
      {props.time}
    </span>
  </div>
);

const ProjectFolder = (props: { name: string; children: any }) => {
  const [expanded, setExpanded] = createSignal(true);
  const toggleExpanded = () => setExpanded((current) => !current);

  return (
    <div class="space-y-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded()}
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          toggleExpanded();
        }}
        class="group flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12"
      >
        <div class="flex items-center gap-2">
          <ChevronRight
            size={14}
            class={`text-gray-8 transition-transform ${expanded() ? "rotate-90" : ""}`}
          />
          <span>{props.name}</span>
        </div>
        <div class="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="Add thread"
            class="rounded-md p-1 text-gray-9 transition-colors hover:bg-gray-3 hover:text-gray-12"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Folder options"
            class="rounded-md p-1 text-gray-9 transition-colors hover:bg-gray-3 hover:text-gray-12"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      <Show when={expanded()}>
        <div class="space-y-1 pl-3">{props.children}</div>
      </Show>
    </div>
  );
};

const AutomationCard = (props: {
  icon: any;
  description: string;
  color?: string;
  onClick?: () => void;
}) => {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="group flex h-full min-h-[120px] w-full min-w-[240px] flex-1 flex-col rounded-2xl border border-gray-6 bg-gray-1/80 p-5 text-left transition-shadow hover:shadow-md"
    >
      <div
        class={`mb-4 flex h-9 w-9 items-center justify-center rounded-xl border border-gray-6 bg-gray-1 ${
          props.color ?? "text-gray-10"
        }`}
      >
        <Icon size={18} />
      </div>
      <p class="text-sm text-gray-10 transition-colors group-hover:text-gray-12">
        {props.description}
      </p>
    </button>
  );
};

const SkillCard = (props: {
  icon: any;
  title: string;
  description: string;
  badge?: string;
  type?: "installed" | "add";
}) => {
  const Icon = props.icon;
  return (
    <div class="flex items-start justify-between rounded-2xl border border-gray-6 bg-gray-1/70 p-4 transition-colors hover:border-gray-7">
      <div class="flex gap-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-6 bg-gray-1 shadow-sm">
          <Icon size={20} class="text-gray-11" />
        </div>
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-sm font-semibold text-gray-12">{props.title}</h4>
            <Show when={props.badge}>
              <span class="flex items-center gap-1 rounded-full border border-gray-6 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-9">
                <Box size={10} />
                {props.badge}
              </span>
            </Show>
          </div>
          <p class="mt-1 text-xs text-gray-9 truncate max-w-[220px]">
            {props.description}
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label={props.type === "add" ? "Install skill" : "Edit skill"}
        class="rounded-lg p-2 text-gray-8 transition-colors hover:bg-gray-2 hover:text-gray-12"
      >
        <Show when={props.type === "add"} fallback={<Pencil size={14} />}>
          <Plus size={16} />
        </Show>
      </button>
    </div>
  );
};

const CreateAutomationModal = (props: { open: boolean; onClose: () => void }) => (
  <Show when={props.open}>
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-12/30 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-automation-title"
        class="w-full max-w-2xl rounded-3xl border border-gray-6 bg-gray-1 shadow-xl"
      >
        <div class="p-8">
          <div class="mb-4 flex items-start justify-between">
            <div>
              <h2 id="create-automation-title" class="text-xl font-semibold text-gray-12">
                Create automation
              </h2>
              <p class="mt-2 text-xs text-gray-9">
                Automate recurring tasks in the background. Codex adds findings to the inbox or
                archives the task when nothing changes.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close modal"
              onClick={props.onClose}
              class="rounded-full p-2 text-gray-8 transition-colors hover:bg-gray-2 hover:text-gray-12"
            >
              <X size={18} />
            </button>
          </div>
          <div class="space-y-5">
            <div>
              <label for="automation-name" class="text-[11px] font-bold uppercase tracking-wider text-gray-8">
                Name
              </label>
              <input
                id="automation-name"
                type="text"
                value="Daily bug scan"
                class="mt-2 w-full rounded-2xl border border-gray-6 bg-gray-2/60 px-3 py-2 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-7"
              />
            </div>
            <div>
              <label for="automation-project" class="text-[11px] font-bold uppercase tracking-wider text-gray-8">
                Projects
              </label>
              <input
                id="automation-project"
                type="text"
                placeholder="Choose a folder"
                class="mt-2 w-full rounded-2xl border border-gray-6 bg-gray-2/60 px-3 py-2 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-7"
              />
            </div>
            <div>
              <label for="automation-prompt" class="text-[11px] font-bold uppercase tracking-wider text-gray-8">
                Prompt
              </label>
              <div class="mt-2 rounded-2xl border border-gray-6 bg-gray-2/60 p-3">
                <textarea
                  id="automation-prompt"
                  class="min-h-[120px] w-full resize-none bg-transparent text-sm text-gray-11 focus:outline-none"
                  value="Scan recent commits for tests that failed before release. Summarize the risk."
                />
              </div>
            </div>
            <div>
              <div class="mb-3 flex items-center justify-between">
                <label class="text-[11px] font-bold uppercase tracking-wider text-gray-8">Schedule</label>
                <div class="flex rounded-full border border-gray-6 bg-gray-2/60 p-1">
                  <button type="button" class="rounded-full bg-gray-12 px-3 py-1 text-[10px] font-bold text-gray-1">
                    Daily
                  </button>
                  <button type="button" class="rounded-full px-3 py-1 text-[10px] font-bold text-gray-9">
                    Interval
                  </button>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-3">
                <div class="flex min-w-[120px] flex-1 items-center justify-between rounded-2xl border border-gray-6 bg-gray-2/60 px-3 py-2 text-sm text-gray-11">
                  <span>09:00</span>
                  <Clock size={16} class="text-gray-8" />
                </div>
                <div class="flex flex-wrap gap-2">
                  <For each={["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]}>
                    {(day) => (
                      <button
                        type="button"
                        class={`h-8 w-8 rounded-full text-[10px] font-bold ${
                          day === "Sa" || day === "Su"
                            ? "bg-gray-2 text-gray-9"
                            : "bg-gray-12 text-gray-1"
                        }`}
                      >
                        {day}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="flex items-center justify-end gap-3 border-t border-gray-6 bg-gray-2/40 px-8 py-4">
          <button
            type="button"
            onClick={props.onClose}
            class="px-4 py-2 text-xs font-medium text-gray-9 hover:text-gray-12"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled
            class="cursor-not-allowed rounded-lg bg-gray-3 px-4 py-2 text-xs font-medium text-gray-8"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  </Show>
);

export default function ProtoV1UxView() {
  const [activeTab, setActiveTab] = createSignal<TabKey>("new-thread");
  const [inputValue, setInputValue] = createSignal("");
  const [modalOpen, setModalOpen] = createSignal(false);
  const sendEnabled = createMemo(() => inputValue().trim().length > 0);

  return (
    <main class="min-h-screen bg-gray-1 text-gray-12">
      <div class="relative min-h-screen">
        <div class="pointer-events-none absolute inset-0">
          <div class="absolute -top-24 left-1/2 h-72 w-[60rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-gray-2/80 via-gray-1 to-gray-2/80 blur-3xl" />
          <div class="absolute bottom-0 right-0 h-64 w-64 rounded-full bg-gradient-to-br from-blue-3/40 to-transparent blur-3xl" />
        </div>

        <div class="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row lg:gap-4 lg:px-6">
          <aside class="flex w-full flex-col gap-6 rounded-3xl border border-gray-6 bg-gray-1/80 p-4 lg:w-72">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-6 bg-gray-2">
                  <Terminal size={18} class="text-gray-11" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-12">OpenWork</div>
                  <div class="text-xs text-gray-9">Proto v1 UX</div>
                </div>
              </div>
              <button
                type="button"
                aria-label="Worker settings"
                class="rounded-lg p-2 text-gray-8 transition-colors hover:bg-gray-2 hover:text-gray-12"
              >
                <Settings size={16} />
              </button>
            </div>

            <nav class="space-y-1">
              <For each={navTabs}>
                {(item) => (
                  <SidebarItem
                    icon={item.icon}
                    label={item.label}
                    active={activeTab() === item.id}
                    onClick={() => setActiveTab(item.id)}
                  />
                )}
              </For>
            </nav>

            <div class="flex-1 overflow-hidden">
              <div class="flex items-center justify-between px-3 text-[11px] font-bold uppercase tracking-wider text-gray-8">
                <span>Threads</span>
                <div class="flex items-center gap-1">
                  <Layout size={14} class="text-gray-8" />
                  <Plus size={14} class="text-gray-8" />
                </div>
              </div>
              <div class="mt-3 space-y-3 overflow-y-auto pr-1">
                <ProjectFolder name="zerofinance">
                  <For each={threadItems}>
                    {(item) => <ThreadItem text={item.text} time={item.time} />}
                  </For>
                </ProjectFolder>
                <button type="button" class="px-3 text-xs font-medium text-gray-9 hover:text-gray-12">
                  Show more
                </button>
              </div>
            </div>

            <SidebarItem icon={Settings} label="Settings" />
          </aside>

          <section class="flex min-h-[70vh] flex-1 flex-col overflow-hidden rounded-3xl border border-gray-6 bg-gray-1/90 shadow-sm">
            <Switch>
              <Match when={activeTab() === "skills"}>
                <header class="flex h-16 items-center justify-between border-b border-gray-6 px-6">
                  <div class="flex items-center gap-4">
                    <button type="button" class="flex items-center gap-2 text-xs font-medium text-gray-9 hover:text-gray-12">
                      <RefreshCw size={14} />
                      Refresh
                    </button>
                    <div class="relative">
                      <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-8" />
                      <input
                        type="text"
                        aria-label="Search skills"
                        placeholder="Search skills"
                        class="w-44 rounded-lg border border-gray-6 bg-gray-2/60 py-2 pl-9 pr-4 text-xs text-gray-11 transition-all focus:w-56 focus:outline-none focus:ring-1 focus:ring-blue-7"
                      />
                    </div>
                  </div>
                  <button type="button" class="rounded-lg bg-gray-12 px-3 py-2 text-xs font-medium text-gray-1 hover:bg-gray-11">
                    <span class="flex items-center gap-2">
                      <Plus size={14} />
                      New skill
                    </span>
                  </button>
                </header>

                <div class="flex-1 overflow-y-auto px-6 pb-12 pt-6">
                  <div class="mb-8">
                    <h2 class="text-2xl font-semibold text-gray-12">Skills</h2>
                    <p class="mt-1 text-sm text-gray-9">
                      Give Codex superpowers. <span class="text-blue-9">Learn more</span>
                    </p>
                  </div>

                  <div class="mb-10">
                    <h3 class="mb-4 text-[11px] font-bold uppercase tracking-widest text-gray-8">Installed</h3>
                    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <For each={skillInstalled}>
                        {(skill) => (
                          <SkillCard
                            icon={skill.icon}
                            title={skill.title}
                            description={skill.description}
                            badge={skill.badge}
                          />
                        )}
                      </For>
                    </div>
                  </div>

                  <div>
                    <h3 class="mb-4 text-[11px] font-bold uppercase tracking-widest text-gray-8">Recommended</h3>
                    <div class="grid grid-cols-1 gap-4 pb-12 md:grid-cols-2">
                      <For each={skillRecommended}>
                        {(skill) => (
                          <SkillCard
                            icon={skill.icon}
                            title={skill.title}
                            description={skill.description}
                            type="add"
                          />
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Match>

              <Match when={activeTab() === "automations"}>
                <header class="flex h-16 items-center justify-end border-b border-gray-6 px-6">
                  <div class="flex items-center gap-4">
                    <button type="button" class="text-xs font-medium text-gray-9 hover:text-gray-12">
                      Learn more
                    </button>
                    <button
                      type="button"
                      onClick={() => setModalOpen(true)}
                      class="rounded-lg bg-gray-12 px-3 py-2 text-xs font-medium text-gray-1 hover:bg-gray-11"
                    >
                      <span class="flex items-center gap-2">
                        <Plus size={14} />
                        New automation
                      </span>
                    </button>
                  </div>
                </header>

                <div class="flex flex-1 flex-col items-center overflow-y-auto px-6 pb-16 pt-10">
                  <div class="mb-10 text-center">
                    <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-gray-6 bg-gray-2 shadow-sm">
                      <Terminal size={28} class="text-gray-9" />
                    </div>
                    <div class="flex items-center justify-center gap-2">
                      <h2 class="text-2xl font-semibold text-gray-12">Automations</h2>
                      <span class="rounded-full border border-gray-6 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-9">
                        Beta
                      </span>
                    </div>
                    <p class="mt-2 text-sm text-gray-9">Automate work by setting up scheduled tasks.</p>
                  </div>
                  <div class="grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <For each={automationTemplates}>
                      {(card) => (
                        <AutomationCard
                          icon={card.icon}
                          description={card.description}
                          color={card.color}
                          onClick={() => setModalOpen(true)}
                        />
                      )}
                    </For>
                  </div>
                  <button type="button" class="mt-10 text-xs text-gray-9 hover:text-gray-12">
                    Explore more
                  </button>
                </div>
              </Match>

              <Match when={true}>
                <header class="flex h-16 items-center justify-between border-b border-gray-6 px-6">
                  <h1 class="text-sm font-semibold text-gray-12">New thread</h1>
                  <div class="flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-lg border border-gray-6 px-3 py-2 text-gray-11 transition-colors hover:bg-gray-2"
                    >
                      <ExternalLink size={14} class="text-blue-9" />
                      Open
                      <ChevronDown size={12} />
                    </button>
                    <div class="h-4 w-px bg-gray-6" />
                    <div class="flex items-center gap-2 text-[10px] font-bold">
                      <span class="text-emerald-9">+9,674</span>
                      <span class="text-red-9">-6,229</span>
                    </div>
                  </div>
                </header>

                <div class="relative flex flex-1 flex-col items-center justify-center px-6 pb-24">
                  <div class="mb-12 text-center">
                    <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-gray-6 bg-gray-2 shadow-sm">
                      <Terminal size={32} class="text-gray-9" />
                    </div>
                    <h2 class="text-3xl font-semibold text-gray-12">Let's build</h2>
                    <button type="button" class="group mt-2 flex items-center justify-center gap-2 text-xl font-medium text-gray-9 hover:text-gray-12">
                      zerofinance
                      <ChevronDown size={18} class="transition-transform group-hover:translate-y-0.5" />
                    </button>
                  </div>

                  <div class="grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-3">
                    <For each={promptSuggestions}>
                      {(card) => (
                        <AutomationCard
                          icon={card.icon}
                          description={card.description}
                          color={card.color}
                        />
                      )}
                    </For>
                  </div>

                  <div class="absolute bottom-6 w-full max-w-3xl">
                    <div class="rounded-2xl border border-gray-6 bg-gray-1 px-3 py-2 shadow-lg">
                      <textarea
                        rows={1}
                        placeholder="Ask Codex anything..."
                        value={inputValue()}
                        onInput={(event) => setInputValue(event.currentTarget.value)}
                        class="min-h-[44px] w-full resize-none bg-transparent p-3 text-sm text-gray-12 focus:outline-none"
                      />
                      <div class="flex items-center justify-between px-2 pb-2">
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label="Add attachment"
                            class="rounded-md p-1.5 text-gray-8 transition-colors hover:bg-gray-2 hover:text-gray-12"
                          >
                            <Plus size={18} />
                          </button>
                          <button
                            type="button"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
                          >
                            GPT-5-Codex
                            <ChevronDown size={14} />
                          </button>
                        </div>
                        <div class="flex items-center gap-3">
                          <button
                            type="button"
                            aria-label="Send"
                            disabled={!sendEnabled()}
                            class={`rounded-full p-2 transition-colors ${
                              sendEnabled()
                                ? "bg-gray-12 text-gray-1"
                                : "bg-gray-3 text-gray-8"
                            }`}
                          >
                            <ArrowUp size={18} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Match>
            </Switch>
          </section>
        </div>

        <CreateAutomationModal open={modalOpen()} onClose={() => setModalOpen(false)} />
      </div>
    </main>
  );
}

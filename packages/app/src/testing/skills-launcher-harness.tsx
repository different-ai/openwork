/* @refresh reload */
import { For, createSignal } from "solid-js";
import { render } from "solid-js/web";

import SkillsView from "../app/pages/skills";
import { bootstrapTheme } from "../app/theme";
import type { SkillCard } from "../app/types";
import { initLocale } from "../i18n";
import "../app/index.css";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const installedSkills: SkillCard[] = [
  {
    name: "skill-creator",
    path: "/tmp/.opencode/skills/skill-creator/SKILL.md",
    description: "Create or update a skill",
  },
];

function SkillsLauncherHarness() {
  const [eventLog, setEventLog] = createSignal<string[]>([]);
  const [importCount, setImportCount] = createSignal(0);
  const [sessionCount, setSessionCount] = createSignal(0);
  const [promptValue, setPromptValue] = createSignal("");
  const [openedUrl, setOpenedUrl] = createSignal("");
  const [savedSkills, setSavedSkills] = createSignal<string[]>([]);

  const originalOpen = window.open.bind(window);
  window.open = ((url?: string | URL | undefined, target?: string, features?: string) => {
    setOpenedUrl(String(url ?? ""));
    setEventLog((current) => [...current, `open:${String(url ?? "")}`]);
    return null;
  }) as typeof window.open;

  window.addEventListener(
    "beforeunload",
    () => {
      window.open = originalOpen;
    },
    { once: true },
  );

  return (
    <div class="min-h-screen bg-dls-hover px-6 py-10">
      <div class="mx-auto max-w-7xl space-y-8">
        <SkillsView
          workspaceName="Harness Worker"
          busy={false}
          canInstallSkillCreator
          canUseDesktopTools
          refreshSkills={() => undefined}
          refreshHubSkills={() => undefined}
          skills={installedSkills}
          skillsStatus={null}
          hubSkills={[]}
          hubSkillsStatus={null}
          importLocalSkill={() => {
            setImportCount((current) => current + 1);
            setEventLog((current) => [...current, "import-local"]);
          }}
          installSkillCreator={async () => ({ ok: true, message: "Installed" })}
          installHubSkill={async (name) => ({ ok: true, message: `Installed ${name}` })}
          revealSkillsFolder={() => undefined}
          uninstallSkill={() => undefined}
          readSkill={async () => null}
          saveSkill={(input) => {
            setSavedSkills((current) => [...current, input.name]);
            setEventLog((current) => [...current, `save:${input.name}`]);
          }}
          createSessionAndOpen={() => {
            setSessionCount((current) => current + 1);
            setEventLog((current) => [...current, "create-session"]);
          }}
          setPrompt={(value) => {
            setPromptValue(value);
            setEventLog((current) => [...current, `prompt:${value}`]);
          }}
        />

        <section class="rounded-2xl border border-dls-border bg-dls-surface p-5 shadow-sm">
          <h1 class="text-sm font-semibold text-dls-text">Harness state</h1>
          <div class="mt-4 grid gap-3 text-xs text-dls-secondary md:grid-cols-2">
            <div>
              <div class="font-semibold text-dls-text">Import count</div>
              <div data-testid="import-count">{importCount()}</div>
            </div>
            <div>
              <div class="font-semibold text-dls-text">Session count</div>
              <div data-testid="session-count">{sessionCount()}</div>
            </div>
            <div>
              <div class="font-semibold text-dls-text">Prompt</div>
              <div data-testid="prompt-value" class="font-mono break-all">
                {promptValue()}
              </div>
            </div>
            <div>
              <div class="font-semibold text-dls-text">Opened URL</div>
              <div data-testid="opened-url" class="font-mono break-all">
                {openedUrl()}
              </div>
            </div>
          </div>

          <div class="mt-4">
            <div class="font-semibold text-dls-text">Saved skills</div>
            <ul data-testid="saved-skills" class="mt-2 space-y-1 text-xs text-dls-secondary">
              <For each={savedSkills()}>{(name) => <li>{name}</li>}</For>
            </ul>
          </div>

          <div class="mt-4">
            <div class="font-semibold text-dls-text">Event log</div>
            <ul data-testid="event-log" class="mt-2 space-y-1 text-xs text-dls-secondary">
              <For each={eventLog()}>{(entry) => <li>{entry}</li>}</For>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

render(() => <SkillsLauncherHarness />, root);

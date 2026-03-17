import { For, createMemo, createSignal } from "solid-js";
import { Boxes, KeyRound, Link2 } from "lucide-solid";

import { MiniInventoryCard, RecipeRow, StoryNavCard, SurfaceSection, ToggleChip } from "./components/common";
import { ShareWorkerSheet } from "./components/share-worker";
import { playbookNotes, stories, surfaceRecipe, type StoryId } from "./data/playbook";

function App() {
  const [activeStory, setActiveStory] = createSignal<StoryId>("live-access");
  const [activeTab, setActiveTab] = createSignal<"access" | "links">("access");
  const [mobilePreview, setMobilePreview] = createSignal(false);
  const [revealedFields, setRevealedFields] = createSignal<Record<string, boolean>>({});
  const [copiedFieldId, setCopiedFieldId] = createSignal<string | null>(null);

  const activeStoryMeta = createMemo(() => stories.find((story) => story.id === activeStory()) ?? stories[0]);

  const pulseCopy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures in preview mode.
    }

    setCopiedFieldId(id);
    window.setTimeout(() => {
      setCopiedFieldId((current) => (current === id ? null : current));
    }, 1400);
  };

  return (
    <main class="min-h-screen px-4 py-5 text-gray-12 sm:px-6 lg:px-8">
      <div class="mx-auto grid max-w-[1600px] gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside class="playbook-panel rounded-[2rem] p-4 sm:p-5">
          <div class="rounded-[1.5rem] border border-white/70 bg-white/70 p-4">
            <div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-11">OpenWork Playbook</div>
            <h1 class="text-[1.55rem] font-semibold tracking-[-0.04em] text-slate-12">Share surfaces</h1>
            <p class="mt-2 text-sm leading-6 text-slate-11">
              A lightweight storybook-style package for reconstructing app components in isolation without drifting away
              from the product shell.
            </p>
          </div>

          <div class="mt-4 space-y-2">
            <For each={stories}>
              {(story) => {
                return (
                  <StoryNavCard
                    selected={activeStory() === story.id}
                    eyebrow={story.eyebrow}
                    label={story.label}
                    description={story.description}
                    onClick={() => {
                      setActiveStory(story.id);
                      setActiveTab(story.id === "public-links" ? "links" : "access");
                    }}
                  />
                );
              }}
            </For>
          </div>

          <div class="mt-4 rounded-[1.35rem] border border-slate-6/60 bg-slate-1/80 p-4">
            <div class="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-10">Notes</div>
            <ul class="mt-3 space-y-2 text-sm leading-6 text-slate-11">
              <For each={playbookNotes}>{(note) => <li>- {note}</li>}</For>
            </ul>
          </div>
        </aside>

        <section class="space-y-4">
          <header class="playbook-panel rounded-[2rem] px-5 py-4 sm:px-6">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div class="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-10">{activeStoryMeta().eyebrow}</div>
                <h2 class="mt-1 text-[1.7rem] font-semibold tracking-[-0.05em] text-slate-12">{activeStoryMeta().label}</h2>
                <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-11">{activeStoryMeta().description}</p>
              </div>

              <div class="flex flex-wrap gap-2">
                <ToggleChip active={!mobilePreview()} onClick={() => setMobilePreview(false)}>
                  Desktop frame
                </ToggleChip>
                <ToggleChip active={mobilePreview()} onClick={() => setMobilePreview(true)}>
                  Mobile width
                </ToggleChip>
                <ToggleChip active={activeTab() === "access"} onClick={() => setActiveTab("access")}> 
                  Live access
                </ToggleChip>
                <ToggleChip active={activeTab() === "links"} onClick={() => setActiveTab("links")}> 
                  Public links
                </ToggleChip>
              </div>
            </div>
          </header>

          <div class="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <div class="playbook-panel playbook-grid rounded-[2rem] p-4 sm:p-5">
              <div
                class={`mx-auto rounded-[2rem] border border-white/70 bg-white/65 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] ${
                  mobilePreview() ? "max-w-[430px]" : "max-w-[1020px]"
                }`}
              >
                <ShareWorkerSheet
                  activeTab={activeTab()}
                  activeStory={activeStory()}
                  copiedFieldId={copiedFieldId()}
                  onCopy={pulseCopy}
                  onTabChange={setActiveTab}
                  revealedFields={revealedFields()}
                  onRevealToggle={(id) =>
                    setRevealedFields((current) => ({
                      ...current,
                      [id]: !current[id],
                    }))
                  }
                />
              </div>
            </div>

            <aside class="space-y-4">
              <SurfaceSection title="Surface recipe">
                <div class="space-y-3 text-sm text-slate-11">
                  <For each={surfaceRecipe}>{(item) => <RecipeRow title={item.title}>{item.body}</RecipeRow>}</For>
                </div>
              </SurfaceSection>

              <SurfaceSection title="Component inventory">
                <div class="space-y-3">
                  <MiniInventoryCard icon={KeyRound} title="Credential rows" note="Masked secrets, helper text, copy affordances" />
                  <MiniInventoryCard icon={Link2} title="Segmented tabs" note="Live access vs public links without modal drift" />
                  <MiniInventoryCard icon={Boxes} title="Publish cards" note="Workspace bundle, skills bundle, and bot setup actions" />
                </div>
              </SurfaceSection>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;

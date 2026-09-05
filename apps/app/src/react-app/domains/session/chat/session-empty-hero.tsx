/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ArrowRight, FileText, FolderOpen, Globe, Table2, X, Zap } from "lucide-react";

import { DEFAULT_MODEL } from "@/app/constants";
import type { ComposerAttachment } from "@/app/types";
import { resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
import { useCheckDesktopRestriction, useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  getOpenWorkModelsActionUrl,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  openWorkModelsPromoChangedEvent,
  useOpenWorkModelsPromoEligibility,
} from "@/react-app/domains/cloud/openwork-models-promo";
import { usePlatform } from "@/react-app/kernel/platform";
import { NewTaskComposer, type NewTaskComposerContext } from "./new-task-composer";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
  icon?: typeof FileText;
};

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  {
    title: "Explore this workspace",
    description: "Find your bearings before making changes.",
    prompt: "Give me an overview of the files in this workspace and suggest one useful first task. Don’t change any files yet.",
    icon: FolderOpen,
  },
  {
    title: "Clean up a spreadsheet",
    description: "Start with your file and the result you want.",
    prompt: "Help me clean up a spreadsheet. Ask me which file to use and what needs fixing, then show me the proposed changes before editing it.",
    icon: Table2,
  },
  {
    title: "Draft a document",
    description: "Turn rough notes into a brief or report.",
    prompt: "Draft a one-page project brief. Ask me for the bullet points you need, then turn them into a clear, well-structured document.",
    icon: FileText,
  },
  {
    title: "Work with a website",
    description: "Research or plan a repetitive browser task.",
    prompt: "Help me with a browser task. Ask which website and what result I want, then propose the steps before taking action.",
    icon: Globe,
  },
];

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt and attachments; the caller creates the session (and workspace if needed). */
  onRunTask: (prompt: string, attachments: ComposerAttachment[]) => void;
  onOpenProviderAuth?: () => void;
  /** Workspace-scoped wiring for the full composer (skills, agents, models). */
  composer?: NewTaskComposerContext | null;
};

/**
 * Paper "first chat" empty state: the real session composer front and
 * center with suggestion cards below. Suggestions come from desktop
 * policies (organization onboarding prompts) when configured, with
 * built-in defaults otherwise.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);
  const orgRestrictions = useOrgRestrictions();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const openWorkModelsPromoEligible = useOpenWorkModelsPromoEligibility();
  const [modelsPromoHidden, setModelsPromoHidden] = useState(isOpenWorkModelsPromoHidden);

  useEffect(() => {
    const handlePromoChanged = () => setModelsPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  // Quiet inline lead to OpenWork Models: replaces the old startup dialog
  // interrupt. Shown only while the session runs on the free starter model
  // (the built-in `opencode` provider) and the hosted offering applies.
  const onFreeStarterModel = props.composer?.selectedModel.providerID === DEFAULT_MODEL.providerID;
  const showModelsHint =
    openWorkModelsPromoEligible &&
    !modelsPromoHidden &&
    !props.composer?.openWorkModelsEntitled &&
    onFreeStarterModel;

  const organizationPrompts = orgRestrictions.onboardingPrompts;
  const suggestions: HeroSuggestion[] = organizationPrompts !== undefined
    ? organizationPrompts.map((orgPrompt, index) => {
      const card = resolveOrganizationPromptCardContent({
        prompt: orgPrompt,
        description: orgRestrictions.onboardingPromptDescriptions?.[index],
        index,
      });
      return { title: card.title, description: card.description, prompt: card.selectionPrompt };
    })
    : DEFAULT_SUGGESTIONS;

  const submit = (resolvedPrompt: string, attachments: ComposerAttachment[]) => {
    const trimmedPrompt = resolvedPrompt.trim();
    if (!trimmedPrompt || props.busy) return;
    props.onRunTask(trimmedPrompt, attachments);
  };

  const fillPrompt = (suggestion: HeroSuggestion) => {
    setPrompt(suggestion.prompt);
    setSelectedSuggestion(suggestion.title);
    window.dispatchEvent(new Event("openwork:focusPrompt"));
  };

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 px-4 max-lg:px-4 sm:px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">
          What do you need done?
        </h2>
        <p className="text-[13px] text-muted-foreground">Start with the outcome. Add files or choose a tool when you need one.</p>
      </div>

      <NewTaskComposer
        draft={prompt}
        onDraftChange={setPrompt}
        onRunTask={submit}
        busy={props.busy ?? false}
        context={props.composer ?? null}
      />

      {showModelsHint ? (
        <div
          className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground"
          data-testid="openwork-models-hint"
        >
          <span>Using the free starter model.</span>
          <button
            type="button"
            className="flex items-center gap-1 font-medium text-foreground transition-colors hover:underline"
            onClick={() => platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn, "sign-up"))}
          >
            Get frontier models with no API keys
            <ArrowRight className="size-3" />
          </button>
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={hideOpenWorkModelsPromo}
            aria-label="Hide OpenWork Models hint"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      {!showModelsHint && canAddProviders && props.providerCount === 0 && props.onOpenProviderAuth ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:bg-accent"
          onClick={props.onOpenProviderAuth}
        >
          <Zap className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-[13px] font-medium text-foreground">Connect a model provider</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              Add an API key for Anthropic, OpenAI, Google, or other providers so tasks can run.
            </div>
          </div>
        </button>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Start with an example</span>
          <span>Edit before you send</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.title}
              type="button"
              className="rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={Boolean(prompt.trim()) || props.busy}
              onClick={() => fillPrompt(suggestion)}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                {suggestion.icon ? <suggestion.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                <span className="truncate">{suggestion.title}</span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-muted-foreground">
                {suggestion.description}
              </div>
            </button>
          ))}
        </div>
        <p className="min-h-5 text-xs leading-5 text-muted-foreground" role="status" aria-live="polite">
          {prompt.trim()
            ? selectedSuggestion
              ? "Example added to your draft. Make it yours, then choose Run task. Clear your draft to choose another."
              : "Your draft is safe. Clear it to choose an example."
            : "Examples fill your draft. Nothing runs until you choose Run task."}
        </p>
      </div>
    </div>
  );
}

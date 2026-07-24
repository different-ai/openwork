/** @jsxImportSource react */
import { useRef, useState } from "react";
import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
import { useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
};

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  {
    title: "Summarize my week",
    description: "Pull highlights from email and calendar.",
    prompt: "Summarize my week: pull the highlights from my connected email and calendar and give me a short digest of what happened and what needs my attention.",
  },
  {
    title: "Clean up a spreadsheet",
    description: "Drop in a CSV and describe the result you want.",
    prompt: "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.",
  },
  {
    title: "Draft a document",
    description: "Reports, emails, or briefs from a few bullet points.",
    prompt: "Draft a one-page project brief. Ask me for the bullet points you need, then turn them into a clear, well-structured document.",
  },
  {
    title: "Automate a web task",
    description: "Use the built-in browser for repetitive steps.",
    prompt: "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.",
  },
];

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt; the caller creates the session (and workspace if needed). */
  onRunTask: (prompt: string) => void;
  onOpenProviderAuth?: () => void;
};

/**
 * Paper "first chat" empty state: a plain-language composer front and
 * center with suggestion cards below. Suggestions come from desktop
 * policies (organization onboarding prompts) when configured, with
 * built-in defaults otherwise.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const orgRestrictions = useOrgRestrictions();

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

  const trimmedPrompt = prompt.trim();
  const submit = () => {
    if (!trimmedPrompt || props.busy) return;
    props.onRunTask(trimmedPrompt);
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    textareaRef.current?.focus();
  };

  return (
    <div className="mx-auto w-full max-w-[560px] space-y-6 px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">
          What do you need done?
        </h2>
        <p className="text-[13px] text-muted-foreground">Describe it in plain language</p>
      </div>

      <div className="rounded-2xl border border-border bg-background p-4 shadow-[var(--dls-card-shadow)] focus-within:border-foreground/25">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          rows={2}
          placeholder="Ask anything, or describe a task..."
          className="w-full resize-none bg-transparent text-[14px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-2">
          <Button size="sm" onClick={submit} disabled={!trimmedPrompt || props.busy}>
            {props.busy ? "Preparing workspace..." : "Run task"}
          </Button>
        </div>
      </div>

      {props.providerCount === 0 && props.onOpenProviderAuth ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl border border-blue-7/50 bg-blue-2/40 p-3.5 text-left transition-colors hover:bg-blue-3/50"
          onClick={props.onOpenProviderAuth}
        >
          <Zap className="mt-0.5 size-4 shrink-0 text-blue-10" />
          <div>
            <div className="text-[13px] font-medium text-foreground">Connect a model provider</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              Add an API key for Anthropic, OpenAI, Google, or other providers so tasks can run.
            </div>
          </div>
        </button>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            className="rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:bg-accent"
            onClick={() => fillPrompt(suggestion.prompt)}
          >
            <div className="truncate text-[13px] font-medium text-foreground">{suggestion.title}</div>
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-muted-foreground">
              {suggestion.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** @jsxImportSource react */
import { useState } from "react";

import {
  PageBackground,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import {
  BotIcon,
  GithubIcon,
  MessageCircleIcon,
  SearchIcon,
  SkipForwardIcon,
  UsersIcon,
} from "lucide-react";

export type AttributionSource =
  | "ai_assistant"
  | "search"
  | "social"
  | "github"
  | "friend_or_colleague";

type AttributionOption = {
  source: AttributionSource;
  label: string;
  description: string;
  icon: typeof BotIcon;
};

const getOptions = (): AttributionOption[] => [
  {
    source: "ai_assistant",
    label: t("welcome.attribution_ai"),
    description: "ChatGPT, Claude, Gemini, Perplexity...",
    icon: BotIcon,
  },
  {
    source: "search",
    label: t("welcome.attribution_search"),
    description: "Google, Bing, DuckDuckGo...",
    icon: SearchIcon,
  },
  {
    source: "social",
    label: t("welcome.attribution_social"),
    description: "X, LinkedIn, YouTube, Reddit...",
    icon: MessageCircleIcon,
  },
  {
    source: "github",
    label: t("welcome.attribution_github"),
    description: t("welcome.attribution_github_desc"),
    icon: GithubIcon,
  },
  {
    source: "friend_or_colleague",
    label: t("welcome.attribution_person"),
    description: t("welcome.attribution_person_desc"),
    icon: UsersIcon,
  },
];

type AttributionStepProps = {
  onSubmit: (source: AttributionSource, aiPrompt?: string) => void;
  onSkip: () => void;
};

/**
 * Self-reported attribution survey shown once during onboarding.
 * When the user picks "AI assistant" we ask which prompt led them
 * here — first-party data on how answer engines describe OpenWork.
 */
export function AttributionStep({ onSubmit, onSkip }: AttributionStepProps) {
  const [aiSelected, setAiSelected] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <PageBackground />
      <PageTitlebarRegion />

      <div data-testid="attribution-step" className="relative z-10 mx-6 w-full max-w-md rounded-3xl border border-border bg-background px-8 py-10">
        <PageHeader className="mb-8 text-center">
          <PageTitle>{t("welcome.attribution_title")}</PageTitle>
          <PageDescription>
            {t("welcome.attribution_desc")}
          </PageDescription>
        </PageHeader>

        {aiSelected ? (
          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground">
              {t("welcome.attribution_ai_prompt")}
            </div>
            <Textarea
              autoFocus
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder={t("welcome.attribution_ai_placeholder")}
              rows={3}
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSubmit("ai_assistant")}
              >
                {t("welcome.attribution_skip_part")}
              </Button>
              <Button size="sm" onClick={() => onSubmit("ai_assistant", aiPrompt)}>
                {t("common.next")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {getOptions().map((option) => (
              <button
                key={option.source}
                type="button"
                className="flex w-full items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
                onClick={() => {
                  if (option.source === "ai_assistant") {
                    setAiSelected(true);
                    return;
                  }
                  onSubmit(option.source);
                }}
              >
                <option.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {option.label}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </div>
              </button>
            ))}

            <div className="pt-1 text-center">
              <Button data-testid="attribution-skip" variant="ghost" size="sm" onClick={onSkip}>
                <SkipForwardIcon className="mr-1.5 size-3.5" />
                {t("welcome.attribution_skip")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

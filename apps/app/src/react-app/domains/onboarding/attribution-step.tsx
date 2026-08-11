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
import {
  BotIcon,
  GithubIcon,
  MessageCircleIcon,
  SearchIcon,
  SkipForwardIcon,
  UsersIcon,
} from "lucide-react";
import { t } from "../../../i18n";

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

const options: AttributionOption[] = [
  {
    source: "ai_assistant",
    label: "onboarding.attribution_option_ai",
    description: "onboarding.attribution_option_ai_desc",
    icon: BotIcon,
  },
  {
    source: "search",
    label: "onboarding.attribution_option_search",
    description: "onboarding.attribution_option_search_desc",
    icon: SearchIcon,
  },
  {
    source: "social",
    label: "onboarding.attribution_option_social",
    description: "onboarding.attribution_option_social_desc",
    icon: MessageCircleIcon,
  },
  {
    source: "github",
    label: "onboarding.attribution_option_github",
    description: "onboarding.attribution_option_github_desc",
    icon: GithubIcon,
  },
  {
    source: "friend_or_colleague",
    label: "onboarding.attribution_option_friend",
    description: "onboarding.attribution_option_friend_desc",
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

      <div className="relative z-10 mx-6 w-full max-w-md rounded-3xl border border-border bg-background px-8 py-10">
        <PageHeader className="mb-8 text-center">
          <PageTitle>{t("onboarding.attribution_title")}</PageTitle>
          <PageDescription>
            {t("onboarding.attribution_desc")}
          </PageDescription>
        </PageHeader>

        {aiSelected ? (
          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground">
              {t("onboarding.attribution_ai_question")}
            </div>
            <Textarea
              autoFocus
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder={t("onboarding.attribution_ai_placeholder")}
              rows={3}
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSubmit("ai_assistant")}
              >
                {t("onboarding.attribution_skip_part")}
              </Button>
              <Button size="sm" onClick={() => onSubmit("ai_assistant", aiPrompt)}>
                {t("onboarding.attribution_continue")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {options.map((option) => (
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
                    {t(option.label)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t(option.description)}
                  </div>
                </div>
              </button>
            ))}

            <div className="pt-1 text-center">
              <Button variant="ghost" size="sm" onClick={onSkip}>
                <SkipForwardIcon className="mr-1.5 size-3.5" />
                {t("onboarding.attribution_skip")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

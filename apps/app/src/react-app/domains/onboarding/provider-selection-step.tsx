/** @jsxImportSource react */
import {
  Page,
  PageBackground,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { KeyRoundIcon, SkipForwardIcon, SparklesIcon } from "lucide-react";

type ProviderSelectionStepProps = {
  showOpenWorkModels?: boolean;
  onOpenWorkModels: () => void;
  onBringYourOwn: () => void;
  onSkip: () => void;
};

export function ProviderSelectionStep({
  showOpenWorkModels = true,
  onOpenWorkModels,
  onBringYourOwn,
  onSkip,
}: ProviderSelectionStepProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <PageBackground />
      <PageTitlebarRegion />

      <div data-testid="provider-selection-step" className="relative z-10 mx-6 w-full max-w-md rounded-3xl border border-border bg-background px-8 py-10">
        <PageHeader className="mb-8 text-center">
          <PageTitle>{t("welcome.provider_title")}</PageTitle>
          <PageDescription>
            {t("welcome.provider_desc")}
          </PageDescription>
        </PageHeader>

        <div className="space-y-3">
          {showOpenWorkModels ? (
            <button
              type="button"
              className="flex w-full items-start gap-4 rounded-xl border border-blue-7/50 bg-blue-2/30 p-4 text-left transition-colors hover:bg-blue-3/40"
              onClick={onOpenWorkModels}
            >
              <SparklesIcon className="mt-0.5 size-5 shrink-0 text-blue-10" />
              <div>
                <div className="text-sm font-medium text-foreground">
                  {t("welcome.provider_openwork_models")}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("welcome.provider_openwork_models_desc")}
                </div>
              </div>
            </button>
          ) : null}

          <button
            type="button"
            className="flex w-full items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
            onClick={onBringYourOwn}
          >
            <KeyRoundIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">
                {t("welcome.provider_api_key")}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("welcome.provider_api_key_desc")}
              </div>
            </div>
          </button>

          <div className="pt-1 text-center">
            <Button data-testid="provider-selection-skip" variant="ghost" size="sm" onClick={onSkip}>
              <SkipForwardIcon className="mr-1.5 size-3.5" />
              {t("welcome.provider_skip")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

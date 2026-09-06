/** @jsxImportSource react */
import { useEffect } from "react";
import { FileTextIcon, LayersIcon, PlugIcon } from "lucide-react";
import { OnboardingIntro } from "@openwork/ui/react";

import { t } from "../../../i18n";
import { useBootState } from "../../shell/boot-state";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import {
  Page,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { useShellConfig } from "../../shell/shell-config";

type WelcomePageProps = {
  onGetStarted: () => void;
  getStartedLabel?: string;
  busy?: boolean;
  error?: string | null;
  manualFolder?: string;
  onManualFolderChange?: (value: string) => void;
  onUseManualFolder?: () => void;
  showManualFolder?: boolean;
  onTeamSignIn?: () => void;
  onJoinOrganization: () => void;
};

export function WelcomePage({
  onGetStarted,
  getStartedLabel,
  busy,
  error,
  manualFolder,
  onManualFolderChange,
  onUseManualFolder,
  showManualFolder,
  onTeamSignIn,
  onJoinOrganization,
}: WelcomePageProps) {
  const { config: shellConfig } = useShellConfig();
  const appName = shellConfig.appName;
  const { markRouteReady } = useBootState();

  // The boot splash overlay stays mounted (and swallows clicks) until the
  // first route marks itself ready. Welcome is a terminal route, so mark it
  // immediately.
  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  return (
    <Page className="min-h-dvh">
      <PageTitlebarRegion />

      <ScrollArea className="relative z-10">
        <ScrollAreaViewport>
          <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6 py-16 sm:px-10">
            <div className="mb-9 flex items-center gap-2.5">
              <img
                src={resolveExtensionIconSrc("/openwork-mark.svg")}
                alt=""
                width={24}
                height={24}
                className="shrink-0 dark:invert"
                aria-hidden="true"
              />
              <span className="text-sm font-semibold tracking-tight">{appName}</span>
            </div>

            <OnboardingIntro
              title={t("welcome.title")}
              description="Ask AI to work on your files. Review and refine the result."
            />

            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 text-[13px] text-muted-foreground" aria-label="What you can do">
              <span className="inline-flex items-center gap-2"><FileTextIcon className="size-4" aria-hidden="true" />Draft with files</span>
              <span className="inline-flex items-center gap-2"><LayersIcon className="size-4" aria-hidden="true" />Reuse skills</span>
              <span className="inline-flex items-center gap-2"><PlugIcon className="size-4" aria-hidden="true" />Connect tools via MCP</span>
            </div>

            <div className="mt-9">
              <Button
                type="button"
                size="lg"
                className="h-11 w-full text-sm font-medium"
                onClick={onGetStarted}
                disabled={busy}
                data-testid="welcome-use-without-cloud"
              >
                {busy
                  ? t("welcome.creating_workspace")
                  : (getStartedLabel || t("welcome.use_without_cloud"))}
              </Button>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Choose a folder, then a model. No OpenWork account needed.
              </p>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              {onTeamSignIn ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-[13px] text-muted-foreground"
                  onClick={onTeamSignIn}
                  disabled={busy}
                  data-testid="welcome-team-signin"
                  aria-label={t("welcome.sign_in_cloud")}
                >
                  Sign in
                </Button>
              ) : null}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-[13px] text-muted-foreground"
                onClick={onJoinOrganization}
                disabled={busy}
                data-testid="welcome-join-org"
              >
                {t("welcome.join_org")}
              </Button>
            </div>

            {error ? (
              <p className="text-center text-xs text-destructive">{error}</p>
            ) : null}

            {showManualFolder ? (
              <div className="mt-6 rounded-xl border border-dashed border-border p-3">
                <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                  Daytona folder path
                  <input
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-ring"
                    value={manualFolder ?? ""}
                    onChange={(event) => onManualFolderChange?.(event.target.value)}
                    placeholder="/workspace/my-project"
                  />
                </label>
                <Button
                  className="mt-2 w-full"
                  variant="outline"
                  onClick={onUseManualFolder}
                  disabled={busy || !manualFolder?.trim()}
                >
                  Use this folder
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}

/** @jsxImportSource react */
import { useEffect } from "react";
import { FileTextIcon, LayersIcon, PlugIcon } from "lucide-react";
import { OnboardingIntro, OnboardingResourceRow } from "@openwork/ui/react";

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
          <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-6 py-16 sm:px-10">
            <div className="mb-10">
              <div className="flex items-center gap-2.5">
                <img
                  src={resolveExtensionIconSrc("/openwork-mark.svg")}
                  alt=""
                  width={26}
                  height={26}
                  className="shrink-0 dark:invert"
                  aria-hidden="true"
                />
                <span className="text-[15px] font-semibold tracking-tight text-foreground">
                  {appName}
                </span>
              </div>
            </div>

            <div className="grid items-start gap-10 md:grid-cols-[1.2fr_1fr] md:gap-14">
              <section aria-label="What you can do">
                <OnboardingIntro
                  eyebrow="Your first useful task"
                  title={t("welcome.title")}
                  description="Turn your files and connected tools into work you can review and refine."
                />
                <div className="mt-7">
                  <OnboardingResourceRow
                    icon={<FileTextIcon className="size-4" />}
                    title="Work with your files"
                    description="Choose a folder, then ask for a brief, a checklist, or changes to a document."
                  />
                  <OnboardingResourceRow
                    icon={<LayersIcon className="size-4" />}
                    title="Reuse skills"
                    description="Skills give the AI repeatable instructions. Discover available skills in the task composer."
                  />
                  <OnboardingResourceRow
                    icon={<PlugIcon className="size-4" />}
                    title="Connect your tools"
                    description="Add MCP connections in your workspace to bring other apps into your tasks. Some tools need their own sign-in."
                  />
                </div>
              </section>

              <section aria-label="Get started" className="rounded-2xl border border-border bg-card p-6">
                <h2 className="text-base font-semibold text-foreground">Start with a folder</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  No OpenWork account needed. Choose a folder, set up a model, then describe your first task.
                </p>
                <Button
                  type="button"
                  size="lg"
                  className="mt-5 h-12 w-full text-[15px] font-semibold"
                  onClick={onGetStarted}
                  disabled={busy}
                  data-testid="welcome-use-without-cloud"
                >
                  {busy
                    ? t("welcome.creating_workspace")
                    : (getStartedLabel || t("welcome.use_without_cloud"))}
                </Button>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  You choose the model provider. Review the result, ask follow-up questions, and refine it in the same task.
                </p>

                {onTeamSignIn ? (
                  <div className="mt-6 border-t border-border pt-5">
                    <p className="mb-3 text-sm leading-6 text-muted-foreground">
                      Already using OpenWork Cloud? Sign in for your team’s shared tools and model access.
                    </p>
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      className="h-12 w-full text-[15px] font-medium"
                      onClick={onTeamSignIn}
                      disabled={busy}
                      data-testid="welcome-team-signin"
                    >
                      {t("welcome.sign_in_cloud")}
                    </Button>
                  </div>
                ) : null}

                <div className="pt-2">
                  <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    onClick={onJoinOrganization}
                    disabled={busy}
                    data-testid="welcome-join-org"
                  >
                    <span className="font-medium text-foreground/90">
                      {t("welcome.join_org")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("welcome.join_org_subtitle")}
                    </span>
                  </button>
                </div>

                {error ? (
                  <p className="text-center text-xs text-destructive">{error}</p>
                ) : null}

                {showManualFolder ? (
                  <div className="rounded-xl border border-dashed border-border p-3">
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
              </section>
            </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}

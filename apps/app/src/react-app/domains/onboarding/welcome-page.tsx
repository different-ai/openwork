/** @jsxImportSource react */
import { useEffect } from "react";
import { FileText, FolderOpen, Globe } from "lucide-react";

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
          <div className="relative flex min-h-dvh items-center justify-center px-6 py-16">
            <div className="relative z-10 w-full max-w-[720px] rounded-3xl border border-border bg-background px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14">
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

              <div className="mt-10 flex flex-col gap-2.5 sm:mt-14">
                <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-foreground sm:text-[38px] sm:leading-[46px]">
                  {t("welcome.title")}
                </h1>
                <p className="text-[15px] leading-[23px] text-muted-foreground">
                  {t("welcome.subtitle")}
                </p>
              </div>

              <div className="mt-7 grid gap-4 border-y border-border py-5" aria-label="What you can do">
                {[
                  { icon: FileText, title: "Turn notes into finished work", description: "Draft briefs, summarize documents, and work with spreadsheets." },
                  { icon: FolderOpen, title: "Work in your own folders", description: "Keep each project’s files and tasks together in a workspace." },
                  { icon: Globe, title: "Bring your tools into the conversation", description: "Use the browser and discover connections when a task needs them." },
                ].map(({ icon: Icon, title, description }) => (
                  <div key={title} className="flex items-start gap-3">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{title}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-7 flex flex-col gap-3">
                {onTeamSignIn ? (
                  <Button
                    type="button"
                    size="lg"
                    className="h-12 w-full text-[15px] font-semibold"
                    onClick={onTeamSignIn}
                    disabled={busy}
                    data-testid="welcome-team-signin"
                  >
                    {t("welcome.sign_in_cloud")}
                  </Button>
                ) : null}

                <Button
                  type="button"
                  size="lg"
                  variant={onTeamSignIn ? "outline" : "default"}
                  className="h-12 w-full text-[15px] font-medium"
                  onClick={onGetStarted}
                  disabled={busy}
                  data-testid="welcome-use-without-cloud"
                >
                  {busy
                    ? t("welcome.creating_workspace")
                    : (getStartedLabel || t("welcome.use_without_cloud"))}
                </Button>

                <p className="text-xs leading-5 text-muted-foreground">
                  Without Cloud, choose a folder on this computer. Sign in to use your team’s shared tools and settings.
                </p>

                <div className="pt-2">
                  <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    onClick={onJoinOrganization}
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
              </div>
            </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}

/** @jsxImportSource react */
import { useEffect } from "react";
import { Dithering } from "@paper-design/shaders-react";
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
          <div className="relative flex min-h-dvh items-center justify-center px-6 py-16">
            {/* Paper first-load spec: subtle black pixel-dither mosaic over a
                near-white ground. `dark:invert` flips the pixels to white so
                the texture survives dark mode. */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.1] dark:invert">
              <Dithering
                className="size-full"
                speed={0.01}
                shape="warp"
                type="2x2"
                size={20.3}
                scale={1.19}
                frame={264559.21}
                colorBack="#00000000"
                colorFront="#000000"
              />
            </div>

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

              <OnboardingIntro
                className="mt-10 sm:mt-14"
                title={t("welcome.title")}
                description={t("welcome.subtitle")}
              />

              <div className="mt-11 flex flex-col gap-3">
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

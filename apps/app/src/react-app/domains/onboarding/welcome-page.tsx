/** @jsxImportSource react */
import { PaperGrainGradient } from "@openwork/ui/react";

import { t } from "../../../i18n";
import {
  Page,
  PageBackground,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { useShellConfig } from "../../shell/shell-config";
import { OrganizationServerAffordance } from "../settings/cloud/organization-server-affordance";

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
  organizationServerBusy: boolean;
  organizationServerError: string | null;
  organizationServerUrl: string;
  onOrganizationServerSave: (url: string) => Promise<boolean>;
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
  organizationServerBusy,
  organizationServerError,
  organizationServerUrl,
  onOrganizationServerSave,
}: WelcomePageProps) {
  const { config: shellConfig } = useShellConfig();
  const appName = shellConfig.appName;

  return (
    <Page className="min-h-screen">
      <PageBackground />
      <PageTitlebarRegion />

      <ScrollArea className="relative z-10">
        <ScrollAreaViewport>
          <div className="relative flex min-h-screen items-center justify-center px-6 py-16">
            <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.35]">
              <PaperGrainGradient
                className="size-full bg-background"
                speed={0}
                scale={1.2}
                rotation={0}
                offsetX={0}
                offsetY={0}
                softness={0.6}
                intensity={0.35}
                noise={0.2}
                shape="corners"
                frame={37706.748}
                colors={["#0E33D9", "#FF7E2E", "#FFE340", "#000000"]}
                colorBack="#00000000"
              />
            </div>

            <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-background p-8 shadow-sm">
              <div className="mb-8 flex items-center gap-2.5">
                <span
                  className="size-7 shrink-0 rounded-md bg-foreground"
                  aria-hidden="true"
                />
                <span className="text-base font-semibold tracking-tight text-foreground">
                  {appName}
                </span>
              </div>

              <div className="mb-8 flex flex-col gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {t("welcome.title")}
                </h1>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("welcome.subtitle")}
                </p>
              </div>

              <div className="flex flex-col gap-3">
                {onTeamSignIn ? (
                  <Button
                    type="button"
                    size="lg"
                    className="w-full"
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
                  variant={onTeamSignIn ? "ghost" : "default"}
                  className="w-full"
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

                <OrganizationServerAffordance
                  busy={organizationServerBusy}
                  error={organizationServerError}
                  onSave={onOrganizationServerSave}
                  url={organizationServerUrl}
                />

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

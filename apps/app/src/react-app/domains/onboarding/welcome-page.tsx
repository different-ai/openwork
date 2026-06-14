/** @jsxImportSource react */
import type { ReactNode } from "react";
import { ShareIcon, UserGroupIcon } from "@heroicons/react/24/solid";
import { PaperGrainGradient } from "@openwork/ui/react";

import { t } from "../../../i18n";
import {
  Page,
  PageBackground,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface BrandIconProps {
  slug: string;
  className?: string;
}

function BrandIcon({ slug, className }: BrandIconProps) {
  return (
    <img
      className={cn("block size-4", className)}
      src={`https://cdn.simpleicons.org/${slug}/_/777b84`}
      alt=""
      loading="lazy"
    />
  );
}

const capabilities = [
  {
    slug: "googlesheets",
    title: "Edit spreadsheets",
    desc: "Create, clean, and transform CSV and Excel files.",
  },
  {
    slug: "semanticweb",
    title: "Control your browser",
    desc: "Automate the built-in browser for repetitive web tasks.",
  },
  {
    slug: "apple",
    title: "Organize files",
    desc: "Read, write, and manage files and folders.",
  },
  {
    slug: "zapier",
    title: "Automate tasks",
    desc: "Build reusable workflows with skills and commands.",
  },
  {
    slug: "medium",
    title: "Generate content",
    desc: "Draft documents, emails, and reports.",
  },
  {
    slug: "stripe",
    title: "Connect to APIs",
    desc: "Plug into external services and tools via MCP.",
  },
];

function ShowcasePanel() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          Your computer,
          <br />
          but it works for you.
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {capabilities.map((cap) => (
          <div
            key={cap.title}
            className="flex flex-col gap-2.5 rounded-xl border border-border p-3"
          >
            <BrandIcon className="size-4" slug={cap.slug} />
            <div className="text-sm font-medium leading-tight text-foreground">
              {cap.title}
            </div>
            <div className="text-xs leading-snug text-muted-foreground">
              {cap.desc}
            </div>
          </div>
        ))}
        <div className="flex flex-col items-start gap-2.5 rounded-xl border border-border p-3">
            <ShareIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-1.5">
              <div className="text-sm font-medium text-foreground">
              Shared extensions
              </div>
              <div className="text-xs leading-snug text-muted-foreground">
              Share approved skills, MCPs, and plugins with your organization.
              </div>
            </div>
          </div>
        <div className="flex flex-col items-start gap-2.5 rounded-xl border border-border p-3">
          <UserGroupIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1.5">
            <div className="text-sm font-medium text-foreground">
              Provision your team
            </div>
            <div className="text-xs leading-snug text-muted-foreground">
              Manage workspaces, models, and permissions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type WelcomePageProps = {
  onGetStarted: () => void;
  getStartedLabel?: string;
  busy?: boolean;
  error?: string | null;
  manualFolder?: string;
  onManualFolderChange?: (value: string) => void;
  onUseManualFolder?: () => void;
  showManualFolder?: boolean;
};

type OnboardingStepProps = {
  number: string;
  title: string;
  children: ReactNode;
};

function OnboardingStep({ number, title, children }: OnboardingStepProps) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-sm font-medium text-foreground">
        {number}
      </div>
      <div className="flex flex-col gap-0.5 pt-1">
        <div className="text-base font-medium text-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function WelcomePage({
  onGetStarted,
  getStartedLabel,
  busy,
  error,
  manualFolder,
  onManualFolderChange,
  onUseManualFolder,
  showManualFolder,
}: WelcomePageProps) {
  return (
    <Page className="min-h-screen">
      <PageBackground />

      <PageTitlebarRegion />

      <ScrollArea className="relative z-10">
        <ScrollAreaViewport>
          <div className="flex min-h-screen">
            {/* ---- Left: onboarding steps ---- */}
            <div className="flex w-full flex-col items-center justify-center px-8 py-16 lg:w-[45%] lg:px-12">
              <div className="flex w-full max-w-md flex-col gap-10">
                {/* Header */}
                <PageHeader className="text-left">
                  <PageTitle>{t("welcome.title")}</PageTitle>
                  <PageDescription>{t("welcome.subtitle")}</PageDescription>
                </PageHeader>

                {/* Steps */}
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <h2 className="text-lg font-semibold tracking-tight text-foreground">
                      Get started
                    </h2>
                  </div>
                  <OnboardingStep number="1" title="Pick a folder">
                    Choose any folder on your machine to get started.
                  </OnboardingStep>
                  <OnboardingStep number="2" title="Chat">
                    Describe what you need. OpenWork handles the rest.
                  </OnboardingStep>
                  <OnboardingStep number="3" title="Interact">
                    Review results, approve actions, and iterate.
                  </OnboardingStep>
                </div>

                <div className="space-y-2">
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={onGetStarted}
                    disabled={busy}
                  >
                    {busy ? t("welcome.creating_workspace") : (getStartedLabel || t("welcome.get_started"))}
                  </Button>
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

            {/* ---- Right: shader outer card > white inner card ---- */}
            <div className="hidden lg:flex lg:w-[55%] lg:items-center lg:justify-center lg:p-6">
              <div className="relative w-full max-w-xl overflow-hidden rounded-3xl">
                {/* Shader background */}
                <div className="absolute inset-0 z-0">
                  <PaperGrainGradient
                    className="size-full bg-white"
                    speed={0}
                    scale={1}
                    rotation={0}
                    offsetX={0}
                    offsetY={0}
                    softness={0.5}
                    intensity={0.5}
                    noise={0.25}
                    shape="corners"
                    frame={37706.748}
                    colors={["#0E33D9", "#FF7E2E", "#FFE340", "#000000"]}
                    colorBack="#00000000"
                  />
                </div>

                {/* Inner white card */}
                <div className="relative z-10 m-3 rounded-2xl bg-background p-7">
                  <ShowcasePanel />
                </div>
              </div>
            </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}

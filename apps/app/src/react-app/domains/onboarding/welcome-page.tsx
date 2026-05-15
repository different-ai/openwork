/** @jsxImportSource react */
import { FolderOpen, MessageSquare, MousePointerClick, Users, Share2 } from "lucide-react";
import { PaperGrainGradient } from "@openwork/ui/react";

import { t } from "../../../i18n";

/* ------------------------------------------------------------------ */
/*  Brand icon via Simple Icons CDN                                    */
/* ------------------------------------------------------------------ */

function BrandIcon({ slug, size = 18 }: { slug: string; size?: number }) {
  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      style={{ display: "block" }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Capabilities + team features (right-side card content)             */
/* ------------------------------------------------------------------ */

const capabilities = [
  { slug: "googlesheets", title: "Edit spreadsheets", desc: "Create, clean, and transform CSV and Excel files." },
  { slug: "googlechrome", title: "Control your browser", desc: "Automate Chrome for repetitive web tasks." },
  { slug: "apple", title: "Organize files", desc: "Read, write, and manage files and folders." },
  { slug: "zapier", title: "Automate tasks", desc: "Build reusable workflows with skills and commands." },
  { slug: "medium", title: "Generate content", desc: "Draft documents, emails, and reports." },
  { slug: "stripe", title: "Connect to APIs", desc: "Plug into external services and tools via MCP." },
];

function ShowcasePanel() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-dls-text">
          Your computer,
          <br />
          but it works for you.
        </h2>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {capabilities.map((cap) => (
          <div
            key={cap.title}
            className="flex flex-col gap-1.5 rounded-xl border border-dls-border bg-dls-surface p-3"
          >
            <BrandIcon slug={cap.slug} size={18} />
            <div className="text-[12px] font-medium leading-tight text-dls-text">
              {cap.title}
            </div>
            <div className="text-[11px] leading-snug text-dls-secondary">
              {cap.desc}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3">
          <Share2 size={16} className="mt-0.5 shrink-0 text-dls-secondary" strokeWidth={1.5} />
          <div>
            <div className="text-[12px] font-medium text-dls-text">
              Share in one link
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-dls-secondary">
              Package skills, MCPs, and configs for your team.
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3">
          <Users size={16} className="mt-0.5 shrink-0 text-dls-secondary" strokeWidth={1.5} />
          <div>
            <div className="text-[12px] font-medium text-dls-text">
              Provision your team
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-dls-secondary">
              Manage workspaces, models, and permissions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  3-step onboarding list                                             */
/* ------------------------------------------------------------------ */

const steps = [
  {
    number: "1",
    icon: FolderOpen,
    title: "Select a folder",
    desc: "Pick any folder on your machine to create a workspace.",
  },
  {
    number: "2",
    icon: MessageSquare,
    title: "Chat",
    desc: "Describe what you need. OpenWork handles the rest.",
  },
  {
    number: "3",
    icon: MousePointerClick,
    title: "Interact",
    desc: "Review results, approve actions, and iterate.",
  },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

type WelcomePageProps = {
  onGetStarted: () => void;
};

export function WelcomePage({ onGetStarted }: WelcomePageProps) {
  return (
    <div className="relative min-h-screen bg-[#fafbfc] text-dls-text">
      {/* Subtle background texture */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -left-[20%] -top-[30%] h-[70%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(14,51,217,0.06),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(255,126,46,0.05),transparent_70%)] blur-3xl" />
        <div className="absolute left-[30%] top-[60%] h-[40%] w-[40%] rounded-full bg-[radial-gradient(ellipse,rgba(255,227,64,0.04),transparent_70%)] blur-3xl" />
      </div>

      {/* Titlebar drag region */}
      <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

      <div className="relative z-10 flex min-h-screen">
        {/* ---- Left: onboarding steps ---- */}
        <div className="flex w-full flex-col items-center justify-center px-8 py-16 lg:w-[45%] lg:px-12">
          <div className="w-full max-w-md space-y-10">
            {/* Header */}
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                {t("welcome.title")}
              </h1>
              <p className="text-sm text-slate-500">
                {t("welcome.subtitle")}
              </p>
            </div>

            {/* Steps */}
            <div className="space-y-4">
              {steps.map((step) => (
                <div
                  key={step.number}
                  className="flex items-start gap-4"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#011627] text-[13px] font-semibold text-white">
                    {step.number}
                  </div>
                  <div className="pt-1">
                    <div className="text-[14px] font-medium text-slate-900">
                      {step.title}
                    </div>
                    <div className="mt-0.5 text-[13px] text-slate-500">
                      {step.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <button
              type="button"
              onClick={onGetStarted}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#011627] text-sm font-semibold text-white transition-all hover:bg-black"
            >
              {t("welcome.get_started")}
            </button>
          </div>
        </div>

        {/* ---- Right: shader outer card > white inner card ---- */}
        <div className="hidden lg:flex lg:w-[55%] lg:items-center lg:justify-center lg:p-6">
          <div className="relative w-full max-w-xl overflow-hidden rounded-3xl">
            {/* Shader background */}
            <div className="absolute inset-0 z-0">
              <PaperGrainGradient
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
                style={{ backgroundColor: "#FFFFFF", width: "100%", height: "100%" }}
              />
            </div>

            {/* Inner white card */}
            <div className="relative z-10 m-3 rounded-2xl bg-white p-7">
              <ShowcasePanel />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

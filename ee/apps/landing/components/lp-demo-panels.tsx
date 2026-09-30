"use client";

import { BarChart3, Globe, LayoutGrid, Lock, Plug, Route, Shield, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { LpCopyButton, LpCopyIcon } from "./lp-copy";
import { LpDemoDesktop } from "./lp-demo-desktop";
import { LibraryView } from "./lp-demo-library";
import { DemoMenu, focusRing } from "./lp-demo-ui";
import { MCP_CLIENTS, MCP_SERVER_URL } from "./lp-mcp-clients";
import { GoogleDriveMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";
import { OpenWorkMark } from "./openwork-mark";

const selectClass = `flex h-7 items-center rounded-lg px-2.5 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] ${focusRing}`;

/* ------------------------------------------------------------------ */
/* MCP Gateway                                                         */
/* ------------------------------------------------------------------ */

type Audience = "Everyone" | "Marketing" | "Just me";
const AUDIENCES: Audience[] = ["Everyone", "Marketing", "Just me"];
type SharedItem = { id: string; mark: ReactNode; name: string; kind: string; who: Audience };

const SHARED: SharedItem[] = [
  { id: "weekly", mark: <SkillMark className="h-[18px] w-[18px]" />, name: "Weekly update", kind: "Skill", who: "Everyone" },
  { id: "brand", mark: <SkillMark className="h-[18px] w-[18px]" />, name: "Brand voice", kind: "Skill", who: "Marketing" },
  { id: "linear", mark: <LinearMark className="h-[18px] w-[18px]" />, name: "Linear", kind: "Connection", who: "Everyone" },
  { id: "drive", mark: <GoogleDriveMark className="h-[18px] w-[18px]" />, name: "Google Drive", kind: "Connection", who: "Everyone" },
  { id: "slack", mark: <SlackMark className="h-[18px] w-[18px]" />, name: "Slack", kind: "Connection", who: "Everyone" }
];

export function LpDemoMcp() {
  const [shared, setShared] = useState<SharedItem[]>(SHARED);
  const weekly = shared.find((item) => item.id === "weekly");
  const weeklyShared = weekly?.who !== "Just me";

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      <div className="flex flex-col px-5 py-6 md:w-[600px] md:shrink-0 md:border-r md:border-[#F0F1F3] md:px-8 md:py-7">
        <span className="text-[13px] font-medium text-[#111827]">Connect any agent</span>
        <div className="mt-3 flex h-12 items-center gap-2.5 rounded-xl pl-4 pr-1.5 shadow-[0_0_0_1px_#E5E7EB]">
          <code className="mono min-w-0 flex-1 truncate text-[13px] text-[var(--lp-ink)] sm:text-sm">{MCP_SERVER_URL}</code>
          <LpCopyButton value={MCP_SERVER_URL} />
        </div>
        <ul className="mt-5 flex flex-col">
          {MCP_CLIENTS.filter((client) => client.id !== "gemini").map((client) => (
            <li key={client.id} className="flex h-12 items-center gap-3 border-b border-[#F0F1F3]">
              <span className="flex w-4 shrink-0">{client.mark}</span>
              <span className="w-[104px] shrink-0 text-sm font-medium text-[#111827]">{client.name}</span>
              {client.link ? (
                <span className="flex flex-1 justify-end">
                  <a href={client.link.href} className="lp-pill-secondary lp-pill-sm !h-[30px] !px-3 !text-xs">
                    {client.link.label}
                  </a>
                </span>
              ) : client.command ? (
                <span className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-[#F5F7FA] pl-2.5">
                  <code className="mono min-w-0 flex-1 truncate text-[11.5px] text-[#1F2937]">{client.command}</code>
                  <LpCopyIcon value={client.command} label={`Copy the ${client.name} command`} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-1 flex-col bg-[#FAFBFC] px-5 py-6 md:px-8 md:py-7">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-[#111827]">Shared with Acme Studio</span>
          <span className="text-xs text-[#6B7280]">Shows up in every agent</span>
        </div>
        <ul className="mt-3 flex flex-col">
          {shared.map((item) => (
            <li key={item.id} className="flex h-11 items-center gap-3 border-b border-[#EEF0F3]">
              <span className="flex w-[18px] shrink-0">{item.mark}</span>
              <span className="flex-1 text-[13px] font-medium text-[#111827]">{item.name}</span>
              <span className="w-[76px] shrink-0 text-xs text-[#6B7280]">{item.kind}</span>
              <DemoMenu
                label={`Who can use ${item.name}`}
                title="Who can use it"
                trigger={<span>{item.who}</span>}
                items={AUDIENCES.map((audience) => ({ id: audience, label: audience, selected: audience === item.who }))}
                onSelect={(id) => {
                  const next = AUDIENCES.find((audience) => audience === id);
                  if (next) setShared((current) => current.map((entry) => (entry.id === item.id ? { ...entry, who: next } : entry)));
                }}
                placement="bottom"
                align="end"
                triggerClassName={`flex h-7 w-[92px] items-center justify-end rounded-md px-2 text-xs text-[#374151] hover:bg-white ${focusRing}`}
              />
            </li>
          ))}
        </ul>
        <div className="mono mt-5 flex flex-col gap-2 rounded-xl bg-white p-4 text-xs leading-[18px] shadow-[0_0_0_1px_rgba(1,22,39,0.08)]" aria-live="polite">
          <span className="text-[#8A93A0]">claude · Priya</span>
          <span className="text-[var(--lp-ink)]">&gt; Draft this week&apos;s update for #launch</span>
          {weeklyShared ? (
            <>
              <span className="text-[#047857]">● openwork · Used Weekly update skill</span>
              <span className="text-[#047857]">● openwork · Searched issues · Linear</span>
              <span className="text-[var(--lp-ink)]">Draft ready: 23 issues closed this week…</span>
            </>
          ) : (
            <span className="text-[#6B7280]">No Weekly update skill shared with Priya. Drafting from scratch…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI Gateway                                                          */
/* ------------------------------------------------------------------ */

type Provider = { id: string; mark: ReactNode; name: string; models: string; who: string; ready: boolean };

const PROVIDERS: Provider[] = [
  { id: "anthropic", mark: <BrandLogo name="anthropic" className="h-[18px] w-[18px] text-[#191919]" />, name: "Anthropic", models: "Claude Opus, Sonnet, Haiku", who: "Everyone", ready: true },
  { id: "openai", mark: <BrandLogo name="openai" className="h-[18px] w-[18px] text-[#111]" />, name: "OpenAI", models: "GPT-5, GPT-5 mini", who: "Engineering", ready: true },
  { id: "bedrock", mark: <BrandLogo name="aws" className="h-[18px] w-[18px] text-[#232F3E]" />, name: "Amazon Bedrock", models: "Claude, Llama", who: "Everyone", ready: true },
  { id: "vertex", mark: <BrandLogo name="gemini" className="h-[18px] w-[18px] text-[#4285F4]" />, name: "Google Vertex AI", models: "Gemini 3 Pro", who: "Research", ready: true },
  { id: "openrouter", mark: <BrandLogo name="openrouter" className="h-[18px] w-[18px] text-[#6467F2]" />, name: "OpenRouter", models: "DeepSeek V4 Pro, Kimi K2", who: "Engineering", ready: true }
];

const MISTRAL: Provider = { id: "mistral", mark: <BrandLogo name="mistral" className="h-[18px] w-[18px] text-[#FA520F]" />, name: "Mistral", models: "Mistral Large, Codestral", who: "Everyone", ready: true };

const WHO = ["Everyone", "Engineering", "Research", "Marketing"];
const KEY_POLICIES = ["Only models you provide", "Also their own keys"];

type Limit = { who: string; used: number; amount: number; perPerson?: boolean };
const LIMITS: Limit[] = [
  { who: "Everyone", used: 31, amount: 50, perPerson: true },
  { who: "Engineering", used: 1180, amount: 1500 },
  { who: "Design team", used: 276, amount: 300 }
];
const LIMIT_STEPS = [300, 500, 1000, 1500, 2000];

const money = (value: number) => `$${value.toLocaleString("en-US")}`;

export function LpDemoAiGateway() {
  const [providers, setProviders] = useState<Provider[]>(PROVIDERS);
  const [keyPolicy, setKeyPolicy] = useState(KEY_POLICIES[0]);
  const [limits, setLimits] = useState<Limit[]>(LIMITS);
  const hasMistral = providers.some((provider) => provider.id === "mistral");

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      <div className="flex flex-1 flex-col px-5 py-6 md:px-8 md:py-7">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-[#111827]">AI Providers</span>
          <button
            type="button"
            disabled={hasMistral}
            onClick={() => setProviders((current) => [...current, MISTRAL])}
            className={`flex h-[30px] items-center rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white hover:opacity-90 disabled:opacity-40 ${focusRing}`}
          >
            {hasMistral ? "Mistral added" : "Add provider"}
          </button>
        </div>
        <div className="mt-3.5 hidden h-7 items-center gap-3 border-b border-[var(--lp-border)] text-[11px] text-[#6B7280] sm:flex">
          <span className="w-[18px]" />
          <span className="w-[130px]">Provider</span>
          <span className="flex-1">Models</span>
          <span className="w-[108px]">Who can use</span>
          <span className="w-[68px]" />
        </div>
        <ul className="flex flex-col">
          {providers.map((provider) => (
            <li key={provider.id} className="flex h-[52px] items-center gap-3 border-b border-[#F0F1F3]">
              <span className="flex w-[18px] shrink-0">{provider.mark}</span>
              <span className="w-[130px] shrink-0 text-[13px] font-medium text-[#111827]">{provider.name}</span>
              <span className="hidden flex-1 truncate text-xs text-[#4B5563] sm:block">{provider.models}</span>
              <span className="w-[108px] shrink-0">
                <DemoMenu
                  label={`Who can use ${provider.name}`}
                  title="Who can use it"
                  trigger={<span>{provider.who}</span>}
                  items={WHO.map((who) => ({ id: who, label: who, selected: who === provider.who }))}
                  onSelect={(who) => setProviders((current) => current.map((entry) => (entry.id === provider.id ? { ...entry, who } : entry)))}
                  placement="bottom"
                  triggerClassName={`flex h-7 items-center rounded-md px-1.5 text-xs text-[#374151] hover:bg-[#F3F4F6] ${focusRing}`}
                />
              </span>
              <button
                type="button"
                aria-pressed={provider.ready}
                aria-label={`${provider.name}: ${provider.ready ? "Ready" : "Paused"}`}
                onClick={() => setProviders((current) => current.map((entry) => (entry.id === provider.id ? { ...entry, ready: !entry.ready } : entry)))}
                className={`flex h-7 w-[68px] shrink-0 items-center justify-end gap-1.5 rounded-md text-xs ${focusRing} ${provider.ready ? "text-[#047857]" : "text-[#6B7280]"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${provider.ready ? "bg-[var(--lp-status-dot)]" : "bg-[#9CA3AF]"}`} aria-hidden="true" />
                {provider.ready ? "Ready" : "Paused"}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#F5F7FA] px-4 py-3.5">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium text-[#111827]">Who can use models</span>
            <span className="text-xs text-[#4B5563]">
              {keyPolicy === KEY_POLICIES[0] ? "Members can't add their own keys." : "Members can add their own keys too."}
            </span>
          </span>
          <DemoMenu
            label="Who can use models"
            trigger={<span>{keyPolicy}</span>}
            items={KEY_POLICIES.map((policy) => ({ id: policy, label: policy, selected: policy === keyPolicy }))}
            onSelect={setKeyPolicy}
            align="end"
            triggerClassName={`flex h-[30px] items-center rounded-lg bg-white px-3 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB] ${focusRing}`}
          />
        </div>
      </div>
      <div className="flex flex-col bg-[#FAFBFC] px-5 py-6 md:w-[380px] md:shrink-0 md:border-l md:border-[#F0F1F3] md:px-8 md:py-7">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-[#111827]">Spend limits</span>
          <span className="text-xs text-[#6B7280]">This month</span>
        </div>
        <span className="mt-3.5 text-[32px] font-medium tracking-[-0.03em] text-[var(--lp-ink)]">$3,240</span>
        <span className="text-xs text-[#4B5563]">Spent by 48 people. Keys stay on the server.</span>
        <ul className="mt-3 flex flex-col">
          {limits.map((limit) => {
            const percent = Math.min(100, Math.round((limit.used / limit.amount) * 100));
            const warn = percent >= 90;
            return (
              <li key={limit.who} className="flex flex-col gap-1.5 border-b border-[#EEF0F3] py-3">
                <span className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[#111827]">{limit.who}</span>
                  {limit.perPerson ? (
                    <span className="text-[#4B5563]">{money(limit.used)} avg of {money(limit.amount)} / person</span>
                  ) : (
                    <DemoMenu
                      label={`Monthly limit for ${limit.who}`}
                      title="Monthly limit"
                      trigger={<span>{money(limit.used)} of {money(limit.amount)}</span>}
                      items={LIMIT_STEPS.map((step) => ({ id: String(step), label: money(step), selected: step === limit.amount }))}
                      onSelect={(id) => setLimits((current) => current.map((entry) => (entry.who === limit.who ? { ...entry, amount: Number(id) } : entry)))}
                      placement="bottom"
                      align="end"
                      triggerClassName={`rounded px-1 text-[#4B5563] underline decoration-dotted underline-offset-2 hover:text-[#111827] ${focusRing}`}
                    />
                  )}
                </span>
                <span className="h-1.5 rounded-full bg-[#E8ECF1]">
                  <span className={`block h-1.5 rounded-full transition-[width] duration-200 ease-out ${warn ? "bg-[#B45309]" : "bg-[var(--lp-ink)]"}`} style={{ width: `${percent}%` }} />
                </span>
                {warn ? <span className="text-[11px] text-[#B45309]">Warning sent at 90%. Pauses at 100%.</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cloud App                                                           */
/* ------------------------------------------------------------------ */

type BrowserTab = "web" | "admin";
type AdminView = "members" | "policies" | "library" | "mcp" | "ai" | "analytics";

const ADMIN_PATH: Record<AdminView, string> = {
  members: "members",
  policies: "policies",
  library: "library",
  mcp: "mcp-gateway",
  ai: "ai-gateway",
  analytics: "analytics"
};

export function LpDemoCloud() {
  const [tab, setTab] = useState<BrowserTab>("web");
  const [adminView, setAdminView] = useState<AdminView>("members");
  const url = tab === "web" ? "app.openworklabs.com/acme-studio/web" : `app.openworklabs.com/acme-studio/${ADMIN_PATH[adminView]}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 bg-[#E9EBEE]">
        <div className="flex h-10 items-end gap-1 px-3" role="group" aria-label="Browser tabs">
          <span className="hidden h-8 items-center gap-[7px] pl-1 pr-2.5 sm:flex" aria-hidden="true">
            <span className="h-[11px] w-[11px] rounded-full bg-[#FF5F57]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#28C840]" />
          </span>
          <BrowserTabButton selected={tab === "web"} onSelect={() => setTab("web")} label="OpenWork Web" />
          <BrowserTabButton selected={tab === "admin"} onSelect={() => setTab("admin")} label="Admin · Acme Studio" />
        </div>
        <div className="flex h-10 items-center border-b border-[#EEF0F3] bg-white px-3">
          <span className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[#F3F4F6] px-3 text-xs text-[#374151]">
            <Lock size={12} className="shrink-0 text-[#6B7280]" aria-hidden="true" />
            <span className="truncate">{url}</span>
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {tab === "web" ? (
          <LpDemoDesktop windowControls={false} />
        ) : (
          <CloudAdmin view={adminView} onView={setAdminView} onOpenWeb={() => setTab("web")} />
        )}
      </div>
    </div>
  );
}

function BrowserTabButton({ selected, onSelect, label }: { selected: boolean; onSelect: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-8 min-w-0 items-center gap-2 rounded-t-lg px-3 text-xs transition-colors duration-150 sm:w-[210px] ${focusRing} ${selected ? "bg-white text-[#111827]" : "text-[#4B5563] hover:bg-[#F1F2F4]"}`}
    >
      <OpenWorkMark className="h-3 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

type AdminNav = { id: AdminView | "web"; icon: ReactNode; label: string };

const ADMIN_NAV: AdminNav[] = [
  { id: "web", icon: <Globe size={16} strokeWidth={1.5} />, label: "Web" },
  { id: "members", icon: <Users size={16} strokeWidth={1.5} />, label: "Members" },
  { id: "library", icon: <LayoutGrid size={16} strokeWidth={1.5} />, label: "Library" },
  { id: "mcp", icon: <Plug size={16} strokeWidth={1.5} />, label: "MCP Gateway" },
  { id: "ai", icon: <Route size={16} strokeWidth={1.5} />, label: "AI Gateway" },
  { id: "policies", icon: <Shield size={16} strokeWidth={1.5} />, label: "Policies" },
  { id: "analytics", icon: <BarChart3 size={16} strokeWidth={1.5} />, label: "Analytics" }
];

function CloudAdmin({ view, onView, onOpenWeb }: { view: AdminView; onView: (view: AdminView) => void; onOpenWeb: () => void }) {
  return (
    <div className="flex min-h-0 w-full">
      <aside className="hidden w-[220px] shrink-0 flex-col gap-0.5 border-r border-[#EEF0F3] bg-[#F7F8FA] px-2.5 py-4 md:flex" aria-label="Admin sidebar">
        <div className="mb-2.5 flex h-10 items-center gap-2.5 px-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--lp-ink)] text-[11px] font-semibold text-white">A</span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-medium text-[#111827]">Acme Studio</span>
            <span className="text-[11px] text-[#6B7280]">Team · free up to 5</span>
          </span>
        </div>
        {ADMIN_NAV.map((item) => {
          const selected = item.id === view;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => (item.id === "web" ? onOpenWeb() : onView(item.id))}
              className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150 ${focusRing} ${selected ? "bg-[#E7EAEE] font-medium text-[var(--lp-ink)]" : "text-[#374151] hover:bg-[#EEF0F3]"}`}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex gap-1 overflow-x-auto border-b border-[#F0F1F3] p-2 md:hidden" role="group" aria-label="Admin views">
          {ADMIN_NAV.filter((item) => item.id !== "web").map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === view}
              onClick={() => item.id !== "web" && onView(item.id)}
              className={`h-8 shrink-0 rounded-lg px-3 text-xs ${focusRing} ${item.id === view ? "bg-[var(--lp-tonal)] font-medium text-[var(--lp-ink)]" : "text-[var(--lp-muted)]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {view === "members" ? <MembersView /> : null}
        {view === "policies" ? <PoliciesView /> : null}
        {view === "library" ? <LibraryView /> : null}
        {view === "mcp" ? <div className="flex min-h-0 flex-1 overflow-y-auto"><LpDemoMcp /></div> : null}
        {view === "ai" ? <div className="flex min-h-0 flex-1 overflow-y-auto"><LpDemoAiGateway /></div> : null}
        {view === "analytics" ? <AnalyticsView /> : null}
      </div>
    </div>
  );
}

type Role = "Owner" | "Admin" | "Member";
const ROLES: Role[] = ["Admin", "Member"];
type Member = { id: string; name: string; email: string; role: Role; invited?: boolean };

const MEMBERS: Member[] = [
  { id: "sam", name: "Sam K.", email: "sam@acme.studio", role: "Owner" },
  { id: "priya", name: "Priya Patel", email: "priya@acme.studio", role: "Admin" },
  { id: "jordan", name: "Jordan Chen", email: "jordan@acme.studio", role: "Member" },
  { id: "dana", name: "Dana Whitman", email: "dana@acme.studio", role: "Member" }
];

const INVITEES = ["alex@acme.studio", "maria@acme.studio", "lee@acme.studio"];
const FREE_SEATS = 5;

function MembersView() {
  const [members, setMembers] = useState<Member[]>(MEMBERS);
  const seats = members.length;
  const over = seats > FREE_SEATS;

  const invite = () => {
    const email = INVITEES[(members.length - MEMBERS.length) % INVITEES.length];
    setMembers((current) => [...current, { id: `${email}-${current.length}`, name: email.split("@")[0].replace(/^./, (letter) => letter.toUpperCase()), email, role: "Member", invited: true }]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Members</h3>
          <span className="text-xs text-[#6B7280]">
            {Math.min(seats, FREE_SEATS)} of {FREE_SEATS} free seats used{over ? ` · ${seats - FREE_SEATS} paid` : ""}
          </span>
        </div>
        <button type="button" onClick={invite} className={`flex h-8 items-center rounded-lg bg-[var(--lp-ink)] px-3.5 text-xs text-white hover:opacity-90 ${focusRing}`}>
          Invite member
        </button>
      </div>
      <div className="mt-4 h-1.5 rounded-full bg-[#E8ECF1]" aria-hidden="true">
        <div className="h-1.5 rounded-full bg-[var(--lp-ink)] transition-[width] duration-200 ease-out" style={{ width: `${Math.min(100, (seats / FREE_SEATS) * 100)}%` }} />
      </div>
      <ul className="mt-4 flex flex-col">
        {members.map((member) => (
          <li key={member.id} className="flex min-h-[52px] items-center gap-3 border-b border-[#F0F1F3]">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--lp-tonal)] text-[11px] font-semibold text-[var(--lp-ink)]">
              {member.name.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-[#111827]">{member.name}</span>
              <span className="truncate text-xs text-[#6B7280]">{member.invited ? `Invited · ${member.email}` : member.email}</span>
            </span>
            {member.role === "Owner" ? (
              <span className="px-2.5 text-xs text-[#6B7280]">Owner</span>
            ) : (
              <DemoMenu
                label={`Role for ${member.name}`}
                title="Role"
                trigger={<span>{member.role}</span>}
                items={ROLES.map((role) => ({ id: role, label: role, selected: role === member.role }))}
                onSelect={(id) => {
                  const role = ROLES.find((entry) => entry === id);
                  if (role) setMembers((current) => current.map((entry) => (entry.id === member.id ? { ...entry, role } : entry)));
                }}
                placement="bottom"
                align="end"
                triggerClassName={selectClass}
              />
            )}
          </li>
        ))}
      </ul>
      {over ? (
        <p className="mt-4 rounded-lg bg-[var(--lp-tonal)] px-3 py-2.5 text-xs text-[#374151]">
          Your workspace includes {FREE_SEATS} free seats. Seat {FREE_SEATS + 1} and up are $10 a month each.
        </p>
      ) : null}
    </div>
  );
}

type Policy = { id: string; label: string; enterprise?: boolean; kind: "toggle" | "select"; options?: string[] };

const POLICIES: Policy[] = [
  { id: "share", label: "Who can share skills with everyone", kind: "select", options: ["Admins", "Admins and members"] },
  { id: "models", label: "Models members can use", kind: "select", options: ["Only models you provide", "Also their own keys"] },
  { id: "invite", label: "Members can invite teammates", kind: "toggle" },
  { id: "cloud-automations", label: "Automations on cloud computers", kind: "toggle" },
  { id: "sso", label: "Single sign-on (Okta, Entra, Google)", kind: "toggle" },
  { id: "desktop", label: "Block local MCP servers on desktops", kind: "toggle", enterprise: true }
];

function PoliciesView() {
  const [toggles, setToggles] = useState<Record<string, boolean>>({ invite: false, "cloud-automations": true });
  const [selects, setSelects] = useState<Record<string, string>>({ share: "Admins", models: "Only models you provide" });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Policies</h3>
        <span className="text-xs text-[#6B7280]">Applies to desktop, web and every MCP client</span>
      </div>
      <ul className="mt-4 flex flex-col">
        {POLICIES.map((policy) => (
          <li key={policy.id} className="flex min-h-[52px] items-center gap-4 border-b border-[#F0F1F3]">
            <span className="flex-1 text-[13px] text-[#111827]">{policy.label}</span>
            {policy.enterprise ? (
              <span className="flex items-center gap-1.5 text-xs text-[#4B5563]">
                <Lock size={12} aria-hidden="true" /> Enterprise
              </span>
            ) : policy.kind === "toggle" ? (
              <button
                type="button"
                role="switch"
                aria-checked={toggles[policy.id] ?? false}
                aria-label={policy.label}
                onClick={() => setToggles((current) => ({ ...current, [policy.id]: !(current[policy.id] ?? false) }))}
                className={`flex h-[18px] w-8 items-center rounded-full p-0.5 transition-colors duration-150 ${focusRing} ${toggles[policy.id] ? "justify-end bg-[var(--lp-ink)]" : "justify-start bg-[#D1D5DB]"}`}
              >
                <span className="h-3.5 w-3.5 rounded-full bg-white" />
              </button>
            ) : (
              <DemoMenu
                label={policy.label}
                trigger={<span>{selects[policy.id]}</span>}
                items={(policy.options ?? []).map((option) => ({ id: option, label: option, selected: option === selects[policy.id] }))}
                onSelect={(value) => setSelects((current) => ({ ...current, [policy.id]: value }))}
                placement="bottom"
                align="end"
                triggerClassName={selectClass}
              />
            )}
          </li>
        ))}
      </ul>
      <span className="mt-4 flex items-center gap-2.5 text-xs text-[#4B5563]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-hidden="true" />
        Changes sync to every member within a minute
      </span>
    </div>
  );
}

const WEEKS = [42, 58, 51, 66, 73, 70, 88, 94];

function AnalyticsView() {
  const [range, setRange] = useState("Last 30 days");
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Analytics</h3>
        <DemoMenu
          label="Date range"
          trigger={<span>{range}</span>}
          items={["Last 7 days", "Last 30 days", "Last 90 days"].map((entry) => ({ id: entry, label: entry, selected: entry === range }))}
          onSelect={setRange}
          placement="bottom"
          align="end"
          triggerClassName={selectClass}
        />
      </div>
      <div className="mt-5 grid grid-cols-3 border-y border-[var(--lp-border)]">
        {[
          ["Tasks run", "1,248"],
          ["Active members", "4 of 5"],
          ["Skills used", "37"]
        ].map(([label, value], index) => (
          <div key={label} className={`flex flex-col gap-1 py-4 ${index ? "border-l border-[var(--lp-border)] pl-4" : ""}`}>
            <span className="text-xs text-[#6B7280]">{label}</span>
            <span className="text-2xl font-medium tracking-[-0.02em] text-[var(--lp-ink)]">{value}</span>
          </div>
        ))}
      </div>
      <div className="mt-6 text-xs font-medium text-[#374151]">Tasks per week</div>
      <div className="mt-3 flex h-32 items-end gap-2" aria-label="Tasks per week, rising from 42 to 94">
        {WEEKS.map((value, index) => (
          <span key={index} className="flex-1 rounded-t bg-[var(--lp-ink)] opacity-80" style={{ height: `${value}%` }} />
        ))}
      </div>
    </div>
  );
}

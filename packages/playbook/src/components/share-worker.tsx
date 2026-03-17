import { For, Show, createMemo } from "solid-js";
import {
  Boxes,
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderCode,
  Globe2,
  KeyRound,
  Link2,
  MessageSquareShare,
  ShieldAlert,
} from "lucide-solid";

import { shareFields, type ShareField, type StoryId } from "../data/playbook";

export function ShareWorkerSheet(props: {
  activeTab: "access" | "links";
  activeStory: StoryId;
  copiedFieldId: string | null;
  onCopy: (id: string, value: string) => Promise<void> | void;
  onTabChange: (tab: "access" | "links") => void;
  revealedFields: Record<string, boolean>;
  onRevealToggle: (id: string) => void;
}) {
  const activeTab = createMemo(() => (props.activeStory === "public-links" ? "links" : props.activeTab));

  return (
    <article class="playbook-panel-strong rounded-[2rem] p-4 sm:p-6">
      <div class="flex items-start gap-4">
        <div class="flex h-16 w-16 items-center justify-center rounded-[1.4rem] bg-slate-12 text-2xl font-semibold text-white shadow-[0_16px_30px_-20px_rgba(15,23,42,0.8)]">
          N
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-[1.9rem] font-semibold tracking-[-0.05em] text-slate-12">Share worker</h3>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-10">
                <span class="font-semibold text-slate-11">new worker</span>
                <span class="h-1 w-1 rounded-full bg-slate-7"></span>
                <span class="truncate font-mono">/Users/benjaminshafii/Desktop/new-worker</span>
              </div>
            </div>
            <button
              type="button"
              class="playbook-button rounded-full border border-slate-6/70 bg-white/80 px-3 py-2 text-xs font-medium text-slate-11 hover:border-slate-8 hover:bg-slate-2"
            >
              Close
            </button>
          </div>

          <div class="mt-6 rounded-[1.5rem] border border-slate-6/70 bg-slate-2/55 p-1">
            <div class="grid grid-cols-2 gap-1">
              <SegmentButton active={activeTab() === "access"} icon={KeyRound} label="Live Access" onClick={() => props.onTabChange("access")} />
              <SegmentButton active={activeTab() === "links"} icon={Link2} label="Public Links" onClick={() => props.onTabChange("links")} />
            </div>
          </div>
        </div>
      </div>

      <Show when={activeTab() === "access"}>
        <div class="mt-6 space-y-5">
          <div class="rounded-[1.5rem] border border-amber-7/55 bg-gradient-to-r from-amber-2 to-amber-1 px-4 py-4 text-amber-12 shadow-[0_20px_36px_-30px_rgba(180,83,9,0.45)] sm:px-5">
            <div class="flex items-start gap-3 text-[15px] leading-7">
              <ShieldAlert class="mt-0.5 shrink-0 text-amber-10" size={20} />
              <p>Share with trusted people only. These credentials grant direct access to your local environment.</p>
            </div>
          </div>

          <div class="space-y-4">
            <For each={props.activeStory === "field-anatomy" ? shareFields.slice(0, 2) : shareFields}>
              {(field) => (
                <CredentialFieldRow
                  field={field}
                  copied={props.copiedFieldId === field.id}
                  onCopy={() => props.onCopy(field.id, field.value)}
                  revealed={Boolean(props.revealedFields[field.id])}
                  onRevealToggle={() => props.onRevealToggle(field.id)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={activeTab() === "links"}>
        <div class="mt-6 grid gap-4 xl:grid-cols-2">
          <PublishCard
            icon={FolderCode}
            title="Workspace profile"
            body="Config, MCP, and skill bundles published as one package-ready link."
            pill="Profile"
            actionLabel="Create public link"
            secondaryLabel="Regenerate link"
            value="https://openwork.app/p/workspace/benjamin/new-worker"
          />
          <PublishCard
            icon={Boxes}
            title="Skills set"
            body="Publish installed skills as a single bundle and keep single-skill flows nearby."
            pill="Bundle"
            actionLabel="Create skill link"
            secondaryLabel="Share single skill"
            value="https://openwork.app/p/skills/new-worker-bundle"
          />
        </div>
      </Show>

      <Show when={activeTab() === "links" && props.activeStory !== "field-anatomy"}>
        <div class="mt-4 grid gap-3 xl:grid-cols-2">
          <ActionRailCard icon={Globe2} title="Config bundle" description="Export local `.opencode` files as a portable package." cta="Export" />
          <ActionRailCard icon={MessageSquareShare} title="Bots" description="Configure share surfaces for Telegram, Slack, and router delivery." cta="Open setup" />
        </div>
      </Show>
    </article>
  );
}

function SegmentButton(props: { active: boolean; icon: typeof KeyRound; label: string; onClick: () => void }) {
  const Icon = props.icon;

  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`playbook-button flex items-center justify-center gap-2 rounded-[1.1rem] px-4 py-3 text-sm font-semibold ${
        props.active
          ? "border border-slate-6 bg-white text-slate-12 shadow-[0_16px_30px_-24px_rgba(15,23,42,0.45)]"
          : "text-slate-10 hover:bg-white/70 hover:text-slate-12"
      }`}
    >
      <Icon size={16} stroke-width={props.active ? 2.5 : 2} />
      {props.label}
    </button>
  );
}

function CredentialFieldRow(props: {
  field: ShareField;
  copied: boolean;
  onCopy: () => void;
  revealed: boolean;
  onRevealToggle: () => void;
}) {
  return (
    <section class="rounded-[1.45rem] border border-slate-6/60 bg-white/80 p-4 shadow-[0_18px_40px_-34px_rgba(15,23,42,0.42)]">
      <div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-10">{props.field.label}</div>
      <div class="flex items-center gap-2 rounded-[1.2rem] border border-slate-6 bg-slate-1 px-4 py-3">
        <div class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[14px] text-slate-12">
          <Show when={!props.field.secret || props.revealed} fallback={<span>{"•".repeat(Math.min(Math.max(props.field.value.length, 28), 54))}</span>}>
            {props.field.value}
          </Show>
        </div>
        <div class="flex items-center gap-1 text-slate-10">
          <Show when={props.field.secret}>
            <button
              type="button"
              onClick={props.onRevealToggle}
              class="playbook-button rounded-full border border-transparent p-2 hover:border-slate-6 hover:bg-slate-2 hover:text-slate-12"
              aria-label={props.revealed ? "Hide value" : "Reveal value"}
            >
              <Show when={props.revealed} fallback={<Eye size={18} />}>
                <EyeOff size={18} />
              </Show>
            </button>
          </Show>
          <button
            type="button"
            onClick={props.onCopy}
            class="playbook-button rounded-full border border-transparent p-2 hover:border-slate-6 hover:bg-slate-2 hover:text-slate-12"
            aria-label={`Copy ${props.field.label}`}
          >
            <Show when={props.copied} fallback={<Copy size={18} />}>
              <Check size={18} class="text-green-10" />
            </Show>
          </button>
        </div>
      </div>
      <p class="mt-3 text-[13px] leading-6 text-slate-10">{props.field.hint}</p>
    </section>
  );
}

function PublishCard(props: {
  icon: typeof FolderCode;
  title: string;
  body: string;
  pill: string;
  actionLabel: string;
  secondaryLabel: string;
  value: string;
}) {
  const Icon = props.icon;

  return (
    <section class="rounded-[1.6rem] border border-slate-6/60 bg-white/82 p-5 shadow-[0_22px_44px_-34px_rgba(15,23,42,0.38)]">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3">
          <div class="flex h-11 w-11 items-center justify-center rounded-[1rem] border border-slate-6/60 bg-slate-2 text-slate-12">
            <Icon size={18} />
          </div>
          <div>
            <div class="text-sm font-semibold text-slate-12">{props.title}</div>
            <div class="mt-1 max-w-sm text-sm leading-6 text-slate-11">{props.body}</div>
          </div>
        </div>
        <span class="rounded-full border border-slate-6/60 bg-slate-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-10">
          {props.pill}
        </span>
      </div>

      <div class="mt-5 rounded-[1.1rem] border border-slate-6 bg-slate-1 px-3 py-2 font-mono text-[12px] text-slate-11">
        {props.value}
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          class="playbook-button rounded-full bg-slate-12 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_16px_28px_-20px_rgba(15,23,42,0.72)] hover:bg-slate-11"
        >
          {props.actionLabel}
        </button>
        <button
          type="button"
          class="playbook-button rounded-full border border-slate-6 bg-white px-4 py-2.5 text-sm font-medium text-slate-11 hover:border-slate-8 hover:bg-slate-2 hover:text-slate-12"
        >
          {props.secondaryLabel}
        </button>
      </div>
    </section>
  );
}

function ActionRailCard(props: { icon: typeof Globe2; title: string; description: string; cta: string }) {
  const Icon = props.icon;

  return (
    <section class="rounded-[1.45rem] border border-slate-6/60 bg-slate-1/85 px-4 py-4 shadow-[0_20px_36px_-34px_rgba(15,23,42,0.38)]">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-slate-6/60 bg-white text-slate-12">
            <Icon size={18} />
          </div>
          <div>
            <div class="text-sm font-semibold text-slate-12">{props.title}</div>
            <div class="mt-1 text-sm text-slate-10">{props.description}</div>
          </div>
        </div>
        <button
          type="button"
          class="playbook-button rounded-full border border-slate-6 bg-white px-3 py-2 text-xs font-semibold text-slate-11 hover:border-slate-8 hover:bg-slate-2 hover:text-slate-12"
        >
          {props.cta}
        </button>
      </div>
    </section>
  );
}

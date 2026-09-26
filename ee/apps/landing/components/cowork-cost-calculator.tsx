"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import {
  anthropicPricingCheckedAt,
  calculatePlanCosts,
  planPrices,
  pricingSources,
  usageProfileIds,
  usageProfiles,
  type PlanCost,
  type PlanId,
  type UsageProfileId
} from "../lib/cowork-cost";
import { modelPrices, modelPricesFetchedAt, type ModelPrice } from "../lib/model-prices";
import { BrandLogo } from "./lp-brand-logos";
import { LpSectionHeader } from "./lp-primitives";

type Props = {
  defaultUsers?: number;
  defaultOpenworkModelId?: string;
  /** The two plans shown as big numbers, Claude first. */
  highlight?: [PlanId, PlanId];
  heading?: string;
};

const claudeModels = modelPrices.filter((model) => model.claude);
const fallbackModel = modelPrices[0];
const sliderMax = 1000;

const shownPlans: { id: PlanId; label: string; note?: string }[] = [
  { id: "claude-team-standard", label: "Claude Team", note: "Excludes usage over plan limits" },
  { id: "claude-enterprise", label: "Claude Enterprise" },
  { id: "claude-3p", label: "Claude on 3P" },
  { id: "openwork-team", label: "OpenWork Team" },
  { id: "openwork-enterprise", label: "OpenWork Enterprise" }
];

const profileLabels: Record<UsageProfileId, string> = { light: "Light", typical: "Typical", heavy: "Heavy" };

function findModel(id: string): ModelPrice {
  return modelPrices.find((model) => model.id === id) ?? fallbackModel;
}

function planLabel(id: PlanId): string {
  return shownPlans.find((plan) => plan.id === id)?.label ?? id;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1
});

const brandByProvider: Record<string, "claude" | "openai" | "gemini" | "mistral"> = {
  anthropic: "claude",
  openai: "openai",
  google: "gemini",
  mistral: "mistral"
};

function ProviderMark({ model }: { model: ModelPrice }) {
  const brand = brandByProvider[model.provider];
  if (brand) return <BrandLogo name={brand} className="h-4 w-4 text-[var(--lp-ink)]" />;
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--lp-ink)] text-[9px] font-semibold text-[var(--lp-page)]"
    >
      {model.providerName.charAt(0)}
    </span>
  );
}

function ModelSelect({
  id,
  label,
  models,
  value,
  onChange
}: {
  id: string;
  label: string;
  models: ModelPrice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const providers = Array.from(new Set(models.map((model) => model.providerName)));
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] text-[var(--lp-muted)]">
        {label}
      </label>
      <div className="relative mt-2">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
          <ProviderMark model={findModel(value)} />
        </span>
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full appearance-none rounded-[12px] bg-[var(--lp-page)] pl-9 pr-9 text-[14px] font-medium text-[var(--lp-ink)] shadow-[0_0_0_1px_var(--lp-border)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--lp-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)]"
        >
          {providers.map((provider) => (
            <optgroup key={provider} label={provider}>
              {models
                .filter((model) => model.providerName === provider)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.5}
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--lp-muted)]"
        />
      </div>
    </div>
  );
}

export function CoworkCostCalculator({
  defaultUsers = 50,
  defaultOpenworkModelId = "deepseek-v4-pro",
  highlight = ["claude-enterprise", "openwork-team"],
  heading = "What will it cost?"
}: Props) {
  const id = useId();
  const [usersText, setUsersText] = useState(String(defaultUsers));
  const [profile, setProfile] = useState<UsageProfileId>("typical");
  const [claudeModelId, setClaudeModelId] = useState("claude-sonnet-5");
  const [openworkModelId, setOpenworkModelId] = useState(defaultOpenworkModelId);

  const parsedUsers = Number(usersText);
  const users = Number.isFinite(parsedUsers) && parsedUsers >= 1 ? Math.round(parsedUsers) : defaultUsers;
  const openworkModel = findModel(openworkModelId);

  const plans = calculatePlanCosts({
    users,
    usage: usageProfiles[profile].usage,
    claudeModel: findModel(claudeModelId),
    openworkModel,
    routeModel: openworkModel,
    routeShare: 0,
    claudeTeamBilling: "annual"
  });

  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const rows = shownPlans.flatMap((shown) => {
    const plan = byId.get(shown.id);
    return plan ? [{ ...shown, plan }] : [];
  });
  const max = Math.max(1, ...rows.filter((row) => row.plan.available).map((row) => row.plan.totalMonthly));
  const [claudeFocus, openworkFocus] = highlight.map((planId) => byId.get(planId));
  const delta = claudeFocus && openworkFocus ? (claudeFocus.totalMonthly - openworkFocus.totalMonthly) * 12 : 0;

  return (
    <section aria-labelledby={`${id}-heading`}>
      <div id={`${id}-heading`}>
        <LpSectionHeader label="Cost calculator" heading={heading} size="small" />
      </div>

      <div className="mt-9 rounded-[24px] bg-[var(--lp-tonal)] p-5 md:p-8">
        <form
          onSubmit={(event) => event.preventDefault()}
          aria-label="Cost calculator inputs"
          className="grid gap-6 md:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1fr]"
        >
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor={`${id}-users`} className="text-[13px] text-[var(--lp-muted)]">
                People
              </label>
              <input
                id={`${id}-users`}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={usersText}
                onChange={(event) => setUsersText(event.target.value)}
                className="h-8 w-[84px] rounded-[8px] bg-[var(--lp-page)] px-2 text-right text-[14px] font-medium tabular-nums text-[var(--lp-ink)] shadow-[0_0_0_1px_var(--lp-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)]"
              />
            </div>
            <input
              type="range"
              min={1}
              max={sliderMax}
              step={1}
              value={Math.min(users, sliderMax)}
              onChange={(event) => setUsersText(event.target.value)}
              aria-label="People, slider"
              className="mt-4 h-11 w-full cursor-pointer accent-[var(--lp-ink)]"
            />
          </div>

          <fieldset>
            <legend className="text-[13px] text-[var(--lp-muted)]">Usage per person</legend>
            <div className="mt-2 grid h-11 grid-cols-3 rounded-[12px] bg-[var(--lp-page)] p-1 shadow-[0_0_0_1px_var(--lp-border)]">
              {usageProfileIds.map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-center rounded-[8px] text-[13px] text-[var(--lp-body)] transition-colors duration-150 has-[:checked]:bg-[var(--lp-ink)] has-[:checked]:font-medium has-[:checked]:text-[var(--lp-page)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--lp-ink)]"
                >
                  <input
                    type="radio"
                    name={`${id}-profile`}
                    value={key}
                    checked={profile === key}
                    onChange={() => setProfile(key)}
                    className="sr-only"
                  />
                  {profileLabels[key]}
                </label>
              ))}
            </div>
          </fieldset>

          <ModelSelect
            id={`${id}-claude-model`}
            label="Claude plans use"
            models={claudeModels}
            value={claudeModelId}
            onChange={setClaudeModelId}
          />
          <ModelSelect
            id={`${id}-openwork-model`}
            label="OpenWork uses"
            models={modelPrices}
            value={openworkModelId}
            onChange={setOpenworkModelId}
          />
        </form>

        <div className="mt-8 grid gap-8 border-t border-[var(--lp-border)] pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-12">
          <div aria-live="polite" className="grid grid-cols-2 gap-6 self-start">
            {[claudeFocus, openworkFocus].map((plan) =>
              plan ? (
                <div key={plan.id}>
                  <div className="text-[13px] text-[var(--lp-muted)]">{planLabel(plan.id)}</div>
                  <div className="mt-1 text-[34px] font-light leading-[40px] tracking-[-0.02em] tabular-nums md:text-[44px] md:leading-[50px]">
                    {plan.available ? compactDollars.format(plan.totalMonthly) : "—"}
                  </div>
                  <div className="text-[13px] text-[var(--lp-muted)]">per month</div>
                </div>
              ) : null
            )}
            <p className="col-span-2 text-[14px] font-medium text-[var(--lp-ink)]">
              {delta >= 0
                ? `OpenWork saves ${dollars.format(delta)} a year`
                : `OpenWork costs ${dollars.format(-delta)} more a year`}
            </p>
          </div>

          <ul aria-label={`Monthly cost for ${users} people`} className="space-y-3.5">
            {rows.map(({ id: planId, label, note, plan }) => (
              <PlanBar
                key={planId}
                label={label}
                note={note}
                plan={plan}
                max={max}
                focused={highlight.includes(planId)}
              />
            ))}
          </ul>
        </div>

        <p className="mt-8 text-[13px] leading-[20px] text-[var(--lp-body)]">
          Tokens outweigh seats, so the model you pick moves the total more than the plan.
        </p>

        <details className="group mt-4 border-t border-[var(--lp-border)] pt-4">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-[var(--lp-ink)] [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              strokeWidth={2}
              className="h-3.5 w-3.5 transition-transform duration-150 ease-out group-open:rotate-90"
            />
            How we calculate
          </summary>
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-[19px] text-[var(--lp-body)]">
            <li>
              Tokens per person = input × (uncached × input price + cached × cache price) + output × output price.
              Presets assume 5M, 25M, or 100M input tokens a month, 70% cached.
            </li>
            <li>
              Claude Team: ${planPrices.claudeTeamStandard.annual}/seat annual, up to {planPrices.claudeTeamMaxSeats} seats.
              Enterprise: ${planPrices.claudeEnterpriseSeat}/seat, {planPrices.claudeEnterpriseMinSeats} minimum, plus tokens.
              3P: tokens only.
            </li>
            <li>
              OpenWork Team: ${planPrices.openworkTeamSeat}/seat plus tokens. Enterprise: ${planPrices.openworkEnterpriseSeat}/user
              annual, volume pricing above {planPrices.openworkEnterpriseVolumeAbove}.
            </li>
            <li>
              List prices from models.dev ({modelPricesFetchedAt}); Anthropic plans checked {anthropicPricingCheckedAt}.
              Committed-spend discounts are not included.
            </li>
            <li className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
              {pricingSources.map((source) => (
                <a
                  key={source.href}
                  href={source.href}
                  className="text-[var(--lp-muted)] underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
                  {...(source.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {source.label}
                </a>
              ))}
            </li>
          </ul>
        </details>
      </div>
    </section>
  );
}

function PlanBar({
  label,
  note,
  plan,
  max,
  focused
}: {
  label: string;
  note?: string;
  plan: PlanCost;
  max: number;
  focused: boolean;
}) {
  const openwork = plan.vendor === "openwork";
  const width = plan.available ? Math.max(1.5, (plan.totalMonthly / max) * 100) : 0;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 md:grid-cols-[150px_minmax(0,1fr)_88px]">
      <div className="min-w-0">
        <div className={`truncate text-[13.5px] ${focused ? "font-medium text-[var(--lp-ink)]" : "text-[var(--lp-body)]"}`}>
          {label}
        </div>
        {note ? <div className="truncate text-[11.5px] text-[var(--lp-muted)]">{note}</div> : null}
      </div>
      <div className="order-last col-span-2 h-2.5 overflow-hidden rounded-full bg-[var(--lp-page)] md:order-none md:col-span-1">
        {plan.available ? (
          <div
            aria-hidden="true"
            className={`h-full rounded-full transition-[width] duration-200 ease-out motion-reduce:transition-none ${
              openwork ? "bg-[var(--lp-ink)]" : focused ? "bg-[var(--lp-muted)]" : "bg-[var(--lp-border)]"
            }`}
            style={{ width: `${width}%` }}
          />
        ) : null}
      </div>
      <div
        className={`text-right text-[13.5px] tabular-nums ${focused ? "font-medium text-[var(--lp-ink)]" : "text-[var(--lp-body)]"}`}
      >
        {plan.available ? dollars.format(plan.totalMonthly) : `Max ${planPrices.claudeTeamMaxSeats}`}
      </div>
    </li>
  );
}

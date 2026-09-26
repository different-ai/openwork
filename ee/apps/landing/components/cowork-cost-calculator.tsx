"use client";

import { useId, useState, type ReactNode } from "react";

import {
  anthropicPricingCheckedAt,
  calculatePlanCosts,
  pricingSources,
  usageProfileIds,
  usageProfiles,
  type Billing,
  type PlanCost,
  type PlanId,
  type Usage,
  type UsageProfileId
} from "../lib/cowork-cost";
import { modelPrices, modelPricesFetchedAt, type ModelPrice } from "../lib/model-prices";
import { LpSectionHeader } from "./lp-primitives";

type Props = {
  defaultUsers?: number;
  defaultOpenworkModelId?: string;
  /** Plans to emphasise, e.g. the 3P comparison. */
  highlight?: PlanId[];
  heading?: string;
};

const billingOptions: Billing[] = ["annual", "monthly"];
const claudeModels = modelPrices.filter((model) => model.claude);
const fallbackModel = modelPrices[0];

function findModel(id: string): ModelPrice {
  return modelPrices.find((model) => model.id === id) ?? fallbackModel;
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const wholeDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fieldClass =
  "mt-1.5 w-full rounded-[10px] border border-[var(--lp-border)] bg-white px-3 py-2 text-[14px] text-[var(--lp-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lp-ink)]";
const labelClass = "block text-[13px] font-medium text-[var(--lp-ink)]";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ModelOptions({ models, markClaude = false }: { models: ModelPrice[]; markClaude?: boolean }) {
  const providers = Array.from(new Set(models.map((model) => model.providerName)));
  return (
    <>
      {providers.map((provider) => (
        <optgroup key={provider} label={provider}>
          {models
            .filter((model) => model.providerName === provider)
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {markClaude && model.claude ? " (works with Cowork)" : ""}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

export function CoworkCostCalculator({
  defaultUsers = 50,
  defaultOpenworkModelId = "deepseek-v4-pro",
  highlight = [],
  heading = "What will it cost?"
}: Props) {
  const id = useId();
  const [usersText, setUsersText] = useState(String(defaultUsers));
  const [profile, setProfile] = useState<UsageProfileId | "custom">("typical");
  const [inputText, setInputText] = useState(String(usageProfiles.typical.usage.inputMillions));
  const [outputText, setOutputText] = useState(String(usageProfiles.typical.usage.outputMillions));
  const [cacheText, setCacheText] = useState(String(usageProfiles.typical.usage.cacheReadShare * 100));
  const [claudeModelId, setClaudeModelId] = useState("claude-sonnet-5");
  const [openworkModelId, setOpenworkModelId] = useState(defaultOpenworkModelId);
  const [routeModelId, setRouteModelId] = useState("deepseek-v4-flash");
  const [routeText, setRouteText] = useState("0");
  const [billing, setBilling] = useState<Billing>("annual");

  const users = Math.max(1, Math.round(parseNumber(usersText, defaultUsers)));
  const usage: Usage = {
    inputMillions: parseNumber(inputText, 0),
    outputMillions: parseNumber(outputText, 0),
    cacheReadShare: Math.min(100, parseNumber(cacheText, 0)) / 100
  };
  const routeShare = Math.min(100, parseNumber(routeText, 0)) / 100;

  const plans = calculatePlanCosts({
    users,
    usage,
    claudeModel: findModel(claudeModelId),
    openworkModel: findModel(openworkModelId),
    routeModel: findModel(routeModelId),
    routeShare,
    claudeTeamBilling: billing
  });

  const lowest = plans
    .filter((plan) => plan.available)
    .reduce<PlanCost | null>((best, plan) => (!best || plan.totalMonthly < best.totalMonthly ? plan : best), null);

  function selectProfile(next: UsageProfileId) {
    setProfile(next);
    const preset = usageProfiles[next].usage;
    setInputText(String(preset.inputMillions));
    setOutputText(String(preset.outputMillions));
    setCacheText(String(preset.cacheReadShare * 100));
  }

  return (
    <section aria-label={heading}>
      <LpSectionHeader label="Cost calculator" heading={heading} size="small" />

      <div className="mt-9 grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-5 self-start rounded-[20px] bg-[var(--lp-tonal)] p-6"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Cost calculator inputs"
        >
          <Field label="People using it" htmlFor={`${id}-users`}>
            <input
              id={`${id}-users`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={usersText}
              onChange={(event) => setUsersText(event.target.value)}
              className={fieldClass}
            />
          </Field>

          <fieldset>
            <legend className={labelClass}>Usage per person</legend>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {usageProfileIds.map((key) => (
                <label
                  key={key}
                  className="cursor-pointer rounded-[10px] border border-[var(--lp-border)] bg-white px-2 py-2 text-center text-[12.5px] text-[var(--lp-body)] transition-colors duration-150 has-[:checked]:border-[var(--lp-ink)] has-[:checked]:text-[var(--lp-ink)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--lp-ink)]"
                >
                  <input
                    type="radio"
                    name={`${id}-profile`}
                    value={key}
                    checked={profile === key}
                    onChange={() => selectProfile(key)}
                    className="sr-only"
                  />
                  {usageProfiles[key].label}
                </label>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Field label="Input (M tokens/mo)" htmlFor={`${id}-input`}>
                <input
                  id={`${id}-input`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={inputText}
                  onChange={(event) => {
                    setProfile("custom");
                    setInputText(event.target.value);
                  }}
                  className={fieldClass}
                />
              </Field>
              <Field label="Output (M tokens/mo)" htmlFor={`${id}-output`}>
                <input
                  id={`${id}-output`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={outputText}
                  onChange={(event) => {
                    setProfile("custom");
                    setOutputText(event.target.value);
                  }}
                  className={fieldClass}
                />
              </Field>
              <Field label="Cached input (%)" htmlFor={`${id}-cache`}>
                <input
                  id={`${id}-cache`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={5}
                  value={cacheText}
                  onChange={(event) => {
                    setProfile("custom");
                    setCacheText(event.target.value);
                  }}
                  className={fieldClass}
                />
              </Field>
            </div>
          </fieldset>

          <Field label="Claude model for Claude plans" htmlFor={`${id}-claude-model`}>
            <select
              id={`${id}-claude-model`}
              value={claudeModelId}
              onChange={(event) => setClaudeModelId(event.target.value)}
              className={fieldClass}
            >
              <ModelOptions models={claudeModels} />
            </select>
          </Field>

          <Field label="Model for OpenWork" htmlFor={`${id}-openwork-model`}>
            <select
              id={`${id}-openwork-model`}
              value={openworkModelId}
              onChange={(event) => setOpenworkModelId(event.target.value)}
              className={fieldClass}
            >
              <ModelOptions models={modelPrices} markClaude />
            </select>
          </Field>

          <div className="grid grid-cols-[1fr_96px] gap-2">
            <Field label="Route some work to" htmlFor={`${id}-route-model`}>
              <select
                id={`${id}-route-model`}
                value={routeModelId}
                onChange={(event) => setRouteModelId(event.target.value)}
                className={fieldClass}
              >
                <ModelOptions models={modelPrices} markClaude />
              </select>
            </Field>
            <Field label="Share (%)" htmlFor={`${id}-route-share`}>
              <input
                id={`${id}-route-share`}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={10}
                value={routeText}
                onChange={(event) => setRouteText(event.target.value)}
                className={fieldClass}
              />
            </Field>
          </div>

          <fieldset>
            <legend className={labelClass}>Claude Team billing</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {billingOptions.map((option) => (
                <label
                  key={option}
                  className="cursor-pointer rounded-[10px] border border-[var(--lp-border)] bg-white px-2 py-2 text-center text-[12.5px] capitalize text-[var(--lp-body)] transition-colors duration-150 has-[:checked]:border-[var(--lp-ink)] has-[:checked]:text-[var(--lp-ink)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--lp-ink)]"
                >
                  <input
                    type="radio"
                    name={`${id}-billing`}
                    value={option}
                    checked={billing === option}
                    onChange={() => setBilling(option)}
                    className="sr-only"
                  />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>
        </form>

        <div className="min-w-0">
          <div aria-live="polite" className="sr-only">
            {lowest ? `Lowest monthly total: ${lowest.name}, ${wholeDollars.format(lowest.totalMonthly)}` : ""}
          </div>

          <div className="hidden md:block">
            <table className="w-full border-collapse text-left text-[14px] leading-[21px]">
              <caption className="sr-only">
                Estimated cost for {users} people, per month and per year
              </caption>
              <thead>
                <tr className="border-b border-[var(--lp-border)] text-[12.5px] text-[var(--lp-muted)]">
                  <th scope="col" className="py-3 pr-4 font-medium">Plan</th>
                  <th scope="col" className="whitespace-nowrap py-3 pr-4 text-right font-medium">Per person / mo</th>
                  <th scope="col" className="whitespace-nowrap py-3 pr-4 text-right font-medium">Total / mo</th>
                  <th scope="col" className="whitespace-nowrap py-3 pr-2 text-right font-medium">Total / yr</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr
                    key={plan.id}
                    className={`border-b border-[var(--lp-border)] align-top ${
                      highlight.includes(plan.id) ? "bg-[var(--lp-tonal)]" : ""
                    }`}
                  >
                    <th scope="row" className="py-4 pl-2 pr-4 font-normal">
                      <PlanLabel plan={plan} lowest={lowest?.id === plan.id} />
                    </th>
                    <PlanNumbers plan={plan} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden">
            {plans.map((plan) => (
              <li
                key={plan.id}
                className={`border-b border-[var(--lp-border)] px-1 py-4 ${
                  highlight.includes(plan.id) ? "rounded-[12px] bg-[var(--lp-tonal)] px-3" : ""
                }`}
              >
                <PlanLabel plan={plan} lowest={lowest?.id === plan.id} />
                {plan.available ? (
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-[13px]">
                    <MobileValue label="Per person / mo" value={cents.format(plan.perUserMonthly)} />
                    <MobileValue label="Total / mo" value={wholeDollars.format(plan.totalMonthly)} />
                    <MobileValue label="Total / yr" value={wholeDollars.format(plan.totalAnnual)} />
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>

          <p className="mt-5 text-[13px] leading-[20px] text-[var(--lp-muted)]">
            Tokens usually cost more than seats, so the model you pick moves the total most.
            OpenWork&apos;s seat costs more than Claude Enterprise&apos;s, and Claude Desktop on 3P has no seat fee.
            The savings come from choosing or routing to cheaper models.
          </p>

          <details className="group mt-5 border-t border-[var(--lp-border)] pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[14px] font-medium text-[var(--lp-ink)] [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="inline-block transition-transform duration-150 group-open:rotate-90">›</span>
              How we calculate
            </summary>
            <div className="mt-3 space-y-2 text-[13px] leading-[20px] text-[var(--lp-body)]">
              <p>
                Tokens per person = input × ((1 − cached share) × input price + cached share × cache-read price) + output × output price.
                Prices are per 1M tokens. When a provider publishes no cache price, cached input uses the input price.
              </p>
              <p>With routing, OpenWork tokens = (1 − share) × main model + share × routed model.</p>
              <p>
                Claude Team: seats × $25 monthly or $20 annual (Standard), $125 or $100 (Premium). 2–150 seats. Usage within plan
                limits is included; usage credits beyond limits are not estimated.
              </p>
              <p>Claude Enterprise: max(people, 20) × $20 + Claude tokens. Claude Desktop on 3P: Claude tokens only.</p>
              <p>OpenWork Team: people × $10 + tokens. OpenWork Enterprise: people × $40 + tokens, billed annually.</p>
              <p>
                Model prices are list API prices from models.dev as of {modelPricesFetchedAt}. Your provider or committed-spend
                price may differ. Anthropic plan prices as of {anthropicPricingCheckedAt}.
              </p>
            </div>
          </details>

          <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[var(--lp-muted)]">
            <span>Sources:</span>
            {pricingSources.map((source) => (
              <a
                key={source.href}
                href={source.href}
                className="underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
                {...(source.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {source.label}
              </a>
            ))}
          </p>
        </div>
      </div>
    </section>
  );
}

function PlanLabel({ plan, lowest }: { plan: PlanCost; lowest: boolean }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14.5px] font-medium text-[var(--lp-ink)]">{plan.name}</span>
        {lowest ? <span className="text-[12px] font-medium text-[var(--lp-status)]">Lowest</span> : null}
      </div>
      <div className="mt-0.5 text-[12.5px] text-[var(--lp-muted)]">{plan.modelLabel}</div>
      {plan.notes.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-[12px] leading-[17px] text-[var(--lp-muted)]">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PlanNumbers({ plan }: { plan: PlanCost }) {
  if (!plan.available) {
    return (
      <td colSpan={3} className="py-4 pr-2 text-right text-[13px] text-[var(--lp-muted)]">
        Not available at this size
      </td>
    );
  }
  return (
    <>
      <td className="py-4 pr-4 text-right tabular-nums">{cents.format(plan.perUserMonthly)}</td>
      <td className="py-4 pr-4 text-right font-medium tabular-nums">{wholeDollars.format(plan.totalMonthly)}</td>
      <td className="py-4 pr-2 text-right tabular-nums">{wholeDollars.format(plan.totalAnnual)}</td>
    </>
  );
}

function MobileValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11.5px] text-[var(--lp-muted)]">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums text-[var(--lp-ink)]">{value}</dd>
    </div>
  );
}

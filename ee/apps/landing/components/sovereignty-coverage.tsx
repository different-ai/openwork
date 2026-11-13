"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  sovereigntyCheckNeeds,
  sovereigntyBestSetup,
  sovereigntyCheckStatus,
  sovereigntyCoverage,
  sovereigntyDefaultSetup,
  sovereigntyHostingOptions,
  sovereigntyModelOptions,
  sovereigntyObjectives,
  type SovereigntyCheckStatus,
  type SovereigntySetup
} from "../lib/sovereign-ai";

type ChoiceOption<T extends string> = { value: T; label: string; detail: string };

function SetupChoice<T extends string>({ legend, options, value, onChange }: { legend: string; options: ChoiceOption<T>[]; value: T; onChange: (value: T) => void }) {
  const name = useId();
  const selected = options.find((option) => option.value === value);
  return (
    <fieldset>
      <legend className="text-sm text-[var(--lp-muted)]">{legend}</legend>
      <div className="mt-3 grid gap-1 rounded-[12px] bg-[var(--lp-page)] p-1 shadow-[0_0_0_1px_var(--lp-border)] sm:grid-flow-col sm:auto-cols-fr">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-10 cursor-pointer items-center justify-center rounded-[8px] px-3 text-center text-sm text-[var(--lp-body)] transition-colors duration-150 ease-out hover:text-[var(--lp-ink)] has-[:checked]:bg-[var(--lp-ink)] has-[:checked]:font-medium has-[:checked]:text-[var(--lp-page)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--lp-ink)] motion-reduce:transition-none"
          >
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="sr-only" />
            {option.label}
          </label>
        ))}
      </div>
      <p className="mt-3 min-h-12 text-sm leading-6 text-[var(--lp-body)]">{selected?.detail}</p>
    </fieldset>
  );
}

function CheckMark({ status }: { status: SovereigntyCheckStatus }) {
  if (status === "answered") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-1.5 h-4 w-4 shrink-0 text-[var(--lp-ink)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5l3.2 3.2L13 4.8" />
      </svg>
    );
  }
  return <span aria-hidden="true" className={`mt-[9px] h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--lp-muted)] ${status === "setup" ? "border-dashed" : ""} mx-[3px]`} />;
}

const statusPrefix: Record<SovereigntyCheckStatus, string> = { answered: "Answered: ", setup: "Not in this setup: ", open: "Open on our side: " };

/** The eight objectives of the Cloud Sovereignty Framework, and how much of each OpenWork answers in the setup the reader picks. */
export function SovereigntyCoverage() {
  const [setup, setSetup] = useState<SovereigntySetup>(sovereigntyDefaultSetup);
  const coverage = sovereigntyCoverage(setup);
  const best = sovereigntyCoverage(sovereigntyBestSetup).percent;
  const left = 100 - coverage.percent;
  const bySetup = best - coverage.percent;
  const onOurSide = 100 - best;

  const changes = [
    ...sovereigntyHostingOptions.filter((option) => option.value !== setup.hosting).map((option) => ({ label: option.change, next: { ...setup, hosting: option.value } })),
    ...sovereigntyModelOptions.filter((option) => option.value !== setup.models).map((option) => ({ label: option.change, next: { ...setup, models: option.value } }))
  ]
    .map((change) => ({ ...change, gain: sovereigntyCoverage(change.next).percent - coverage.percent }))
    .filter((change) => change.gain > 0);

  const openItems = sovereigntyObjectives.flatMap((objective) => objective.checks.filter((check) => check.gap).map((check) => ({ objective, check })));

  return (
    <div className="mt-10">
      <div className="grid gap-8 md:grid-cols-2 md:gap-12">
        <SetupChoice legend="Where OpenWork runs" options={sovereigntyHostingOptions} value={setup.hosting} onChange={(hosting) => setSetup((current) => ({ ...current, hosting }))} />
        <SetupChoice legend="Where the models run" options={sovereigntyModelOptions} value={setup.models} onChange={(models) => setSetup((current) => ({ ...current, models }))} />
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--lp-muted)]">This comparison assumes Enterprise controls are enabled where required. Internal mirrors, encryption, and your identity provider still need configuring.</p>

      <div className="mt-8 grid gap-8 border-t border-[var(--lp-border)] pt-8 md:grid-cols-[220px_minmax(0,1fr)] md:items-center md:gap-12">
        <p aria-live="polite" aria-atomic="true">
          <span className="block text-[4.5rem] font-medium leading-none tracking-[-0.045em] tabular-nums">{coverage.percent}%</span>
          <span className="mt-4 block text-sm leading-6 text-[var(--lp-body)]">of our workspace checks answered in this setup.</span>
        </p>
        <div>
          <div aria-hidden="true" className="flex h-3 gap-0.5 overflow-hidden rounded-full">
            <span className="h-full bg-[var(--lp-ink)] transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${coverage.percent}%` }} />
            {bySetup > 0 ? <span className="h-full bg-[var(--lp-muted)] opacity-60 transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${bySetup}%` }} /> : null}
            <span className="h-full flex-1 bg-[var(--lp-border)]" />
          </div>
          <dl className="mt-5 grid gap-2 sm:grid-cols-3 sm:gap-8">
            <div className="flex items-baseline justify-between gap-4 sm:block">
              <dt className="flex items-center gap-2 text-sm text-[var(--lp-body)]"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--lp-ink)]" />Answered today</dt>
              <dd className="text-xl font-medium tabular-nums sm:mt-1">{coverage.percent}%</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 sm:block">
              <dt className="flex items-center gap-2 text-sm text-[var(--lp-body)]"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--lp-muted)] opacity-60" />More with a different setup</dt>
              <dd className="text-xl font-medium tabular-nums sm:mt-1">{bySetup}%</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 sm:block">
              <dt className="flex items-center gap-2 text-sm text-[var(--lp-body)]"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--lp-border)]" />Open on our side</dt>
              <dd className="text-xl font-medium tabular-nums sm:mt-1">{onOurSide}% <a href="#last" className="ml-1 hidden text-sm font-normal text-[var(--lp-muted)] underline underline-offset-4 hover:text-[var(--lp-ink)] sm:inline">See the list</a></dd>
            </div>
          </dl>
          <p className="mt-5 text-sm leading-6 text-[var(--lp-muted)]">Our own count for the workspace layer. It is not a SEAL level.</p>
        </div>
      </div>

      <div className="mt-10 hidden grid-cols-[220px_minmax(0,1fr)_minmax(0,1.15fr)] gap-12 border-b border-[var(--lp-border)] pb-3 text-sm text-[var(--lp-muted)] md:grid">
        <span>Objective</span>
        <span>What it asks</span>
        <span>What OpenWork answers in this setup</span>
      </div>

      <ol className="mt-10 divide-y divide-[var(--lp-border)] border-y border-[var(--lp-border)] md:mt-0 md:border-t-0">
        {sovereigntyObjectives.map((objective, index) => {
          const { answered, total } = coverage.objectives[index];
          return (
            <li key={objective.code} id={objective.code.toLowerCase()} className="grid scroll-mt-24 gap-5 py-8 md:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.15fr)] md:gap-12">
              <div>
                <p className="mono text-xs text-[var(--lp-muted)]">{objective.code}</p>
                <h3 className="mt-2 text-xl font-medium tracking-tight">{objective.name}</h3>
                <p className="mt-2 text-sm tabular-nums text-[var(--lp-muted)]">{objective.weight}% of the score</p>
                <p className="mt-1 text-sm tabular-nums text-[var(--lp-ink)]">{answered} of {total} answered</p>
                <span aria-hidden="true" className="mt-3 block h-1.5 max-w-[160px] overflow-hidden rounded-full bg-[var(--lp-border)]">
                  <span className="block h-full rounded-full bg-[var(--lp-ink)] transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${(answered / total) * 100}%` }} />
                </span>
              </div>
              <div className="text-base leading-7">
                <p className="text-[var(--lp-body)]">{objective.asks}</p>
                <p className="mt-4 text-sm leading-6 text-[var(--lp-muted)]">Set by<br /><span className="text-[var(--lp-ink)]">{objective.setBy}</span></p>
              </div>
              <ul className="space-y-3 text-base leading-7">
                {objective.checks.map((check) => {
                  const status = sovereigntyCheckStatus(check, setup);
                  return (
                    <li key={check.label} className="flex gap-3">
                      <CheckMark status={status} />
                      <span className={status === "answered" ? "" : "text-[var(--lp-body)]"}>
                        <span className="sr-only">{statusPrefix[status]}</span>
                        {check.label}
                        {status === "setup" ? <span className="block text-sm leading-6 text-[var(--lp-muted)]">Needs {sovereigntyCheckNeeds(check, setup)}.</span> : null}
                        {status === "open" ? <span className="block text-sm leading-6 text-[var(--lp-muted)]"><span className="text-[var(--lp-ink)]">Still open.</span> {check.gap}</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>

      <div id="last" className="mt-16 scroll-mt-24">
        <p className="governance-label">What is left</p>
        <h3 className="governance-heading mt-3" aria-live="polite">The last {left}%.</h3>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">
          {bySetup > 0 ? `You can close ${bySetup}% by changing your setup. The other ${onOurSide}% is open on our side today.` : `There is nothing left to change in your setup. All ${onOurSide}% is open on our side today.`}
        </p>

        {changes.length > 0 ? (
          <div className="mt-8">
            <p className="text-sm text-[var(--lp-muted)]">Close more by changing your setup</p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {changes.map((change) => (
                <button key={change.label} type="button" onClick={() => setSetup(change.next)} className="lp-pill-secondary !h-auto min-h-11 !justify-between !whitespace-normal py-2 text-left !leading-snug sm:!justify-center">
                  {change.label}<span className="mono text-sm tabular-nums text-[var(--lp-muted)]">+{change.gain}%</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-10 border-b border-[var(--lp-border)] pb-3 text-sm text-[var(--lp-muted)]">Open on our side, in any setup</p>
        <ul className="grid md:grid-cols-2 md:gap-x-12">
          {openItems.map(({ objective, check }) => (
            <li key={check.label} className="border-b border-[var(--lp-border)] py-5">
              <p className="mono text-xs text-[var(--lp-muted)]">{objective.code} · {objective.name}</p>
              <p className="mt-2 text-base font-medium leading-7">{check.label}</p>
              <p className="mt-1 text-sm leading-6 text-[var(--lp-body)]">{check.gap}</p>
            </li>
          ))}
        </ul>

        <div className="mt-10 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-12">
          <p className="max-w-[640px] text-base leading-7 text-[var(--lp-body)]">Tell us your setup and the level you are working to. We will go through each open item with you: what we can commit to, what is planned, and what will stay open.</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/enterprise#book" className="lp-pill-primary">Talk to sales about the last {left}%</Link>
            <Link href="/docs/start-here/self-host" className="lp-pill-secondary">Read the self-hosting guide</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

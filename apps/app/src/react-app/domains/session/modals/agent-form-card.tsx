/** @jsxImportSource react */
import { useState } from "react";
import {
  Calendar, Check, Clock, Code, DollarSign, FileText, GitBranch, Layers, Mail, Rocket,
  Server, Shield, ShieldCheck, Smartphone, Sparkles, Users, Wrench, Zap, type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { AgentForm, AgentFormField } from "@openwork/types/agent-form";

const ICONS: Record<string, LucideIcon> = {
  calendar: Calendar, clock: Clock, code: Code, "dollar-sign": DollarSign, "file-text": FileText,
  "git-branch": GitBranch, layers: Layers, mail: Mail, rocket: Rocket, server: Server, shield: Shield,
  "shield-check": ShieldCheck, smartphone: Smartphone, sparkles: Sparkles, users: Users, wrench: Wrench, zap: Zap,
};

const TONE_IDLE: Record<string, string> = {
  warning: "border-amber-7/50 text-amber-11",
  danger: "border-red-7/50 text-red-11",
  success: "border-green-7/50 text-green-11",
};

type Answer = string[];

function initialAnswer(field: AgentFormField): Answer {
  return field.kind === "scale" ? [String(Math.round((field.min + field.max) / 2))] : [];
}

function ChoiceField({ field, value, busy, onChange }: {
  field: Extract<AgentFormField, { kind: "choice" }>; value: Answer; busy: boolean; onChange: (next: Answer) => void;
}) {
  const display = field.display ?? (field.options.some((option) => option.icon) ? "cards" : "list");
  const toggle = (label: string) => {
    if (!field.multiple) return onChange(value[0] === label ? [] : [label]);
    onChange(value.includes(label) ? value.filter((item) => item !== label) : [...value, label]);
  };
  return (
    <div
      role={field.multiple ? "group" : "radiogroup"}
      className={display === "list" ? "divide-y divide-dls-border overflow-hidden rounded-xl border border-dls-border" : "flex flex-wrap gap-2"}
    >
      {field.options.map((option) => {
        const on = value.includes(option.label);
        const Icon = option.icon ? ICONS[option.icon] : undefined;
        const tone = on ? "border-blue-9/40 bg-blue-9/10 text-gray-12" : TONE_IDLE[option.tone ?? ""] ?? "border-dls-border text-gray-12";
        const common = {
          type: "button" as const,
          role: field.multiple ? "checkbox" : "radio",
          "aria-checked": on,
          disabled: busy,
          onClick: () => toggle(option.label),
        };
        if (display === "list") {
          return (
            <button key={option.label} {...common} className={`flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-gray-2 disabled:opacity-60 ${on ? "bg-blue-9/5" : ""}`}>
              <span aria-hidden="true" className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-blue-9 bg-blue-9" : "border-gray-7"}`}>
                {on ? <Check size={10} className="text-white" strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-gray-12">{option.label}</span>
                {option.description ? <span className="mt-0.5 block text-xs text-gray-10">{option.description}</span> : null}
              </span>
            </button>
          );
        }
        if (display === "tiles") {
          return (
            <button key={option.label} {...common} className={`flex w-32 flex-col items-center gap-2 rounded-xl border px-3 py-3 text-center text-sm transition-colors hover:border-gray-8 disabled:opacity-60 ${tone}`}>
              {Icon ? <Icon size={22} aria-hidden="true" /> : null}
              <span className="font-medium">{option.label}</span>
            </button>
          );
        }
        return (
          <button key={option.label} {...common} className={`flex min-w-44 max-w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors hover:border-gray-8 disabled:opacity-60 ${tone}`}>
            {Icon ? <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}
            <span className="min-w-0">
              <span className="block font-medium">{option.label}</span>
              {option.description ? <span className="mt-0.5 block text-xs text-gray-10">{option.description}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AgentFormCard(props: {
  form: AgentForm;
  busy: boolean;
  onReply: (answers: string[][]) => void;
  onDismiss?: () => void;
}) {
  const [answers, setAnswers] = useState<Answer[]>(() => props.form.fields.map(initialAnswer));
  const set = (index: number, next: Answer) => setAnswers((current) => current.map((item, at) => (at === index ? next : item)));
  const answered = answers.some((answer) => answer.some((item) => item.trim() !== ""));
  const inputClass = "rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary focus:border-dls-accent focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]";

  return (
    <section className="my-4 overflow-hidden rounded-2xl border border-dls-border bg-dls-surface" data-question-variant="form" aria-label={props.form.title}>
      <div className="flex items-center gap-2 px-4 pt-3 text-xs font-medium text-amber-11">
        <span className="size-1.5 rounded-full bg-amber-9" aria-hidden="true" />
        {t("question_modal.needs_input")}
      </div>
      <div className="px-4 pb-1 pt-1 text-sm font-medium text-gray-12">{props.form.title}</div>
      <div className="divide-y divide-dls-border">
        {props.form.fields.map((field, index) => (
          <div key={`${index}:${field.question}`} className="space-y-2 px-4 py-3" data-form-field={field.kind}>
            <div className="text-sm text-gray-12">{field.question}</div>
            {field.kind === "choice" ? (
              <ChoiceField field={field} value={answers[index] ?? []} busy={props.busy} onChange={(next) => set(index, next)} />
            ) : field.kind === "scale" ? (
              <div>
                <input
                  type="range" min={field.min} max={field.max} step={1} disabled={props.busy}
                  value={answers[index]?.[0] ?? String(field.min)}
                  onChange={(event) => set(index, [event.currentTarget.value])}
                  aria-label={field.question}
                  className="w-full accent-[var(--dls-accent)]"
                />
                <div className="flex justify-between text-xs text-gray-10"><span>{field.minLabel}</span><span>{field.maxLabel}</span></div>
              </div>
            ) : field.kind === "date" ? (
              <input type="date" disabled={props.busy} value={answers[index]?.[0] ?? ""} aria-label={field.question}
                onChange={(event) => set(index, event.currentTarget.value ? [event.currentTarget.value] : [])} className={inputClass} />
            ) : (
              <textarea rows={3} disabled={props.busy} value={answers[index]?.[0] ?? ""} placeholder={field.placeholder} aria-label={field.question}
                onChange={(event) => set(index, event.currentTarget.value ? [event.currentTarget.value] : [])} className={`w-full resize-y ${inputClass}`} />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-2.5">
        <span className="text-xs text-gray-9">
          {props.busy ? "Submitting..." : props.onDismiss ? t("question_modal.send_skips_hint") : null}
        </span>
        <div className="flex shrink-0 gap-2">
          {props.onDismiss ? (
            <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onDismiss}>{t("question_modal.skip")}</Button>
          ) : null}
          <Button size="sm" disabled={!answered || props.busy} onClick={() => props.onReply(answers.map((answer) => answer.map((item) => item.trim()).filter(Boolean)))}>
            {t("common.submit")}
          </Button>
        </div>
      </div>
    </section>
  );
}

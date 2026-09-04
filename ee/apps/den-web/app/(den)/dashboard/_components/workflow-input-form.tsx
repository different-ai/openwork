"use client";

import { DenInput } from "../../_components/ui/input";
import { humanizeIdentifier } from "./workflow-plain-language";

export type FormField = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  kind: "string" | "integer" | "number" | "boolean";
  inputType: "text" | "date" | "datetime-local" | "number";
  options: string[] | null;
  minimum: number | undefined;
  maximum: number | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

export function formFieldsFromSchema(schema: unknown): FormField[] | null {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
  const required = schema.required === undefined ? [] : stringList(schema.required);
  if (!required) return null;

  const fields: FormField[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) return null;
    const label = typeof property.title === "string" ? property.title : humanizeIdentifier(key.replace(/Iso$/, ""));
    const description = typeof property.description === "string" ? property.description : null;
    const minimum = typeof property.minimum === "number" ? property.minimum : undefined;
    const maximum = typeof property.maximum === "number" ? property.maximum : undefined;

    if (property.type === "string") {
      const options = property.enum === undefined ? null : stringList(property.enum);
      if (property.enum !== undefined && !options) return null;
      const inputType = property.format === "date"
        ? "date"
        : property.format === "date-time"
          ? "datetime-local"
          : "text";
      fields.push({ key, label, description, required: required.includes(key), kind: "string", inputType, options, minimum, maximum });
      continue;
    }
    if (property.type === "integer" || property.type === "number") {
      fields.push({ key, label, description, required: required.includes(key), kind: property.type, inputType: "number", options: null, minimum, maximum });
      continue;
    }
    if (property.type === "boolean") {
      fields.push({ key, label, description, required: required.includes(key), kind: "boolean", inputType: "text", options: null, minimum, maximum });
      continue;
    }
    return null;
  }
  return fields;
}

export function WorkflowInputForm({ schema, value, onChange }: { schema: unknown; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const fields = formFieldsFromSchema(schema);
  if (!fields) return null;

  const update = (field: FormField, nextValue: string | number | boolean) => {
    const next = { ...value };
    if (nextValue === "" && !field.required) delete next[field.key];
    else next[field.key] = nextValue;
    onChange(next);
  };
  const remove = (field: FormField) => {
    const next = { ...value };
    delete next[field.key];
    onChange(next);
  };

  return (
    <div className="mt-2 grid gap-3 sm:grid-cols-2" data-testid="den-workflow-input-form">
      {fields.map((field) => {
        const current = value[field.key];
        if (field.kind === "boolean") {
          return <label key={field.key} className="flex items-start gap-2 text-[12px] font-medium text-gray-600"><input type="checkbox" data-field={field.key} required={field.required} checked={current === true} onChange={(event) => update(field, event.currentTarget.checked)} className="mt-0.5" /><span>{field.label}{field.required ? " *" : ""}{field.description ? <span className="mt-0.5 block font-normal text-gray-400">{field.description}</span> : null}</span></label>;
        }
        if (field.options) {
          return <label key={field.key} className="text-[12px] font-medium text-gray-600">{field.label}{field.required ? " *" : ""}<select data-field={field.key} required={field.required} value={typeof current === "string" ? current : ""} onChange={(event) => update(field, event.currentTarget.value)} className="mt-1 h-9 w-full rounded-xl border border-gray-200 bg-white px-2 text-[13px] text-gray-700"><option value="">Select…</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>{field.description ? <span className="mt-1 block font-normal text-gray-400">{field.description}</span> : null}</label>;
        }
        return <label key={field.key} className="text-[12px] font-medium text-gray-600">{field.label}{field.required ? " *" : ""}<DenInput className="mt-1 h-9" type={field.inputType} data-field={field.key} required={field.required} min={field.minimum} max={field.maximum} step={field.kind === "integer" ? 1 : undefined} value={field.kind === "string" ? (typeof current === "string" ? current : "") : (typeof current === "number" ? current : "")} onChange={(event) => {
          if (field.kind === "string") update(field, event.currentTarget.value);
          else if (event.currentTarget.value === "" || !Number.isFinite(event.currentTarget.valueAsNumber)) remove(field);
          else update(field, event.currentTarget.valueAsNumber);
        }} />{field.description ? <span className="mt-1 block font-normal text-gray-400">{field.description}</span> : null}</label>;
      })}
    </div>
  );
}

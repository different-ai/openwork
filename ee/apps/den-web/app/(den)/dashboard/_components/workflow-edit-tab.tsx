"use client";

import { Save, TestTube2 } from "lucide-react";
import type { WorkflowCapability, WorkflowDetail, WorkflowTestResult } from "@openwork/types/workflows";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTextarea } from "../../_components/ui/textarea";
import { WorkflowInputForm } from "./workflow-input-form";
import { WorkflowMarkdownPreview } from "./workflow-artifact-result";
import { WorkflowFriendlyValue } from "./workflow-friendly-value";
import { describeToolStep } from "./workflow-plain-language";
import type { WorkflowFields } from "./use-workflow-detail-state";

export type WorkflowEditTabProps = {
  detail: WorkflowDetail;
  fields: WorkflowFields;
  parsedInputSchema: unknown;
  hasInputForm: boolean;
  inputFormValue: Record<string, unknown>;
  tested: { result: WorkflowTestResult; fingerprint: string } | null;
  fingerprint: string;
  pending: boolean;
  onUpdate: (key: keyof WorkflowFields, value: string) => void;
  onTest: () => void;
  onSave: () => void;
};

function capabilityDescription(capability: WorkflowCapability): { title: string; service: string } {
  const path = capability.scriptPath.replace(/^tools\./, "").split(".");
  const namespace = path[0] ?? "";
  const tool = path.at(-1) ?? capability.capabilityName;
  return describeToolStep({
    id: capability.capabilityName,
    kind: "tool",
    label: capability.capabilityName,
    namespace,
    tool,
    scriptPath: capability.scriptPath,
    assignsTo: null,
    parallelGroup: null,
  });
}

export function WorkflowEditTab({
  detail,
  fields,
  parsedInputSchema,
  hasInputForm,
  inputFormValue,
  tested,
  fingerprint,
  pending,
  onUpdate,
  onTest,
  onSave,
}: WorkflowEditTabProps) {
  return (
    <div data-tab="edit" role="tabpanel" aria-label="Edit">
      <DenCard size="spacious">
        <DenSectionHeader
          title="Edit workflow"
          description="Test your changes first. When they pass, save them as a new version."
        />
        <div className="mt-6 flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-[12px] font-medium text-gray-600">
              Name
              <DenInput className="mt-1" value={fields.name} onChange={(event) => onUpdate("name", event.currentTarget.value)} />
            </label>
            <label className="text-[12px] font-medium text-gray-600">
              Description
              <DenInput className="mt-1" value={fields.description} onChange={(event) => onUpdate("description", event.currentTarget.value)} />
            </label>
          </div>
          <label className="text-[12px] font-medium text-gray-600">
            Source
            <DenTextarea
              aria-label="Workflow source"
              className="mt-1 min-h-72 font-mono text-[12px]"
              value={fields.code}
              onChange={(event) => onUpdate("code", event.currentTarget.value)}
            />
          </label>
          <div>
            <p className="text-[12px] font-medium text-gray-600">Example input</p>
            {hasInputForm ? (
              <WorkflowInputForm
                schema={parsedInputSchema}
                value={inputFormValue}
                onChange={(next) => onUpdate("input", JSON.stringify(next, null, 2))}
              />
            ) : null}
            <DenTextarea
              aria-label="Example input JSON"
              className="mt-2 min-h-36 font-mono text-[11px]"
              value={fields.input}
              onChange={(event) => onUpdate("input", event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="text-[12px] font-medium text-gray-600">
              What it needs
              <DenTextarea
                className="mt-1 min-h-36 font-mono text-[11px]"
                value={fields.inputSchema}
                onChange={(event) => onUpdate("inputSchema", event.currentTarget.value)}
              />
            </label>
            <label className="text-[12px] font-medium text-gray-600">
              What it returns
              <DenTextarea
                className="mt-1 min-h-36 font-mono text-[11px]"
                value={fields.outputSchema}
                onChange={(event) => onUpdate("outputSchema", event.currentTarget.value)}
              />
            </label>
          </div>
          <div>
            <p className="text-[12px] font-medium text-gray-600">Uses these tools</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {detail.currentVersion.requiredCapabilities.length === 0 ? (
                <DenChip tone="neutral" size="sm">No outside tools</DenChip>
              ) : detail.currentVersion.requiredCapabilities.map((capability) => {
                const description = capabilityDescription(capability);
                return (
                  <DenChip key={`${capability.capabilityName}:${capability.scriptPath}`} tone="neutral" size="sm" title={capability.scriptPath}>
                    {description.title} · {description.service}
                  </DenChip>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-5">
            <DenButton variant="secondary" icon={TestTube2} disabled={pending} onClick={onTest}>
              Test changes
            </DenButton>
            <DenButton
              icon={Save}
              disabled={pending || tested?.fingerprint !== fingerprint}
              onClick={onSave}
            >
              Save new version
            </DenButton>
          </div>
          {tested ? (
            <div className="space-y-4 border-t border-gray-100 pt-5">
              <h3 className="text-[12px] font-medium text-gray-600">Test output</h3>
              <WorkflowFriendlyValue value={tested.result.value} />
              <details className="border-t border-gray-100 pt-3">
                <summary className="cursor-pointer text-[12px] font-medium text-gray-600">Rendered preview</summary>
                <div className="mt-3"><WorkflowMarkdownPreview markdown={tested.result.markdown} /></div>
              </details>
            </div>
          ) : null}
        </div>
      </DenCard>
    </div>
  );
}

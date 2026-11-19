"use client";

import { Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { organizationAutomationSettingsSchema, type OrganizationAutomationSettings } from "@openwork/types/den/automation-settings";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { permissionLockReason } from "../../_lib/den-org";
import { ItemSection } from "./item-list";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";

const viewSchema = z.object({
  settings: organizationAutomationSettingsSchema,
  available: organizationAutomationSettingsSchema,
  deploymentEnabled: z.boolean(),
  headlessRunnerConfigured: z.boolean(),
});
type AutomationSettingsView = z.infer<typeof viewSchema>;

const kinds: { key: keyof OrganizationAutomationSettings; title: string; description: string }[] = [
  { key: "desktop", title: "Desktop Automations", description: "Members schedule work that runs on their own signed-in OpenWork desktop, with its files and apps." },
  { key: "cloud", title: "Cloud Automations", description: "Members and agents schedule work that runs in OpenWork Cloud, even when every computer is off." },
];

/** Settings › Automations: turn each kind of Automation on or off for the whole organization. */
export function OrgAutomationSettingsSection({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<AutomationSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<keyof OrganizationAutomationSettings | null>(null);

  const load = useCallback(async () => {
    try {
      const { response, payload } = await requestJson("/v1/org/automation-settings", { method: "GET" }, 12_000);
      if (!response.ok) { setError(getErrorMessage(payload, "Could not load Automation settings.")); return; }
      const parsed = viewSchema.safeParse(payload);
      if (parsed.success) { setView(parsed.data); setError(null); }
      else setError("Automation settings were incomplete. Refresh to try again.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load Automation settings.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(key: keyof OrganizationAutomationSettings, value: boolean) {
    setSaving(key);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/org/automation-settings", { method: "PUT", body: JSON.stringify({ [key]: value }) }, 12_000);
      if (!response.ok) { setError(getErrorMessage(payload, "Could not save Automation settings.")); return; }
      const parsed = viewSchema.safeParse(payload);
      if (parsed.success) setView(parsed.data);
      else await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save Automation settings.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <ItemSection variant="rule" title="Where Automations can run" testId="org-automation-settings">

      {view && !view.deploymentEnabled ? (
        <DenNotice tone="info" message="Automations are turned off for this whole OpenWork installation by its operator." />
      ) : null}
      {error ? <DenNotice tone="error" message={error} /> : null}

      <div className="grid">
        {kinds.map((kind) => {
          const needsRunner = kind.key === "cloud" && view !== null && !view.headlessRunnerConfigured;
          const checked = view ? view.settings[kind.key] && !needsRunner : false;
          return (
            <div key={kind.key} className="flex min-h-12 items-start justify-between gap-4 border-b border-[var(--den-list-line)] py-3" data-testid={`org-automation-${kind.key}`}>
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="text-[13px] font-medium text-[var(--dls-text-primary)]">{kind.title}</p>
                <p className="text-[12px] text-[var(--dls-text-secondary)]">{kind.description}</p>
                {needsRunner ? (
                  <p className="flex items-center gap-1.5 text-[12px] text-[var(--dls-text-secondary)]" data-testid="org-automation-cloud-locked">
                    <Lock size={12} aria-hidden="true" />
                    Needs OpenWork&apos;s headless runner on this installation. Ask your OpenWork operator to set it up.
                  </p>
                ) : null}
                {!canManage ? <p className="text-[12px] text-gray-500">{permissionLockReason("organization.update")}</p> : null}
              </div>
              <DenSwitch
                aria-label={kind.title}
                checked={checked}
                disabled={!view || !canManage || needsRunner || saving !== null}
                onChange={(next) => void save(kind.key, next)}
              />
            </div>
          );
        })}
      </div>
      <p className="pt-2 text-[12px] text-[var(--dls-text-secondary)]">Turning one off skips its scheduled runs; existing Automations and their history are kept.</p>
    </ItemSection>
  );
}

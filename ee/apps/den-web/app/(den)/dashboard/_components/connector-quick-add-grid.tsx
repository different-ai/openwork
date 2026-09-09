"use client";

import { ArrowRight, Check, Loader2, Plus } from "lucide-react";
import { EFFORT_LABELS, type ConnectorEffort, presetEffort } from "./connector-effort";
import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";
import { IntegrationIcon } from "./integration-icon";

export const GOOGLE_WORKSPACE_QUICK_ADD_ID = "google-workspace";
export const MICROSOFT_365_QUICK_ADD_ID = "microsoft-365";

const SUITE_CONNECTORS = [
  {
    id: GOOGLE_WORKSPACE_QUICK_ADD_ID,
    displayName: "Google Workspace",
    description: "Your company's Google. Set it up once — every member connects their own account.",
    iconUrl: "/integrations/google.svg",
  },
  {
    id: MICROSOFT_365_QUICK_ADD_ID,
    displayName: "Microsoft 365",
    description: "Outlook mail, calendar, and OneDrive. Each teammate connects their own work account.",
    simpleIconSlug: "microsoft",
  },
];

const EFFORT_TONES: Record<ConnectorEffort, string> = {
  guided: "bg-gray-100 text-gray-600",
  one_click: "bg-emerald-50 text-emerald-700",
  api_key: "bg-gray-100 text-gray-600",
  oauth_app: "bg-amber-50 text-amber-700",
  instant: "bg-emerald-50 text-emerald-700",
};

const PILL_CLASSES = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";

function EffortPill({ effort }: { effort: ConnectorEffort }) {
  return <span className={`${PILL_CLASSES} ${EFFORT_TONES[effort]}`}>{EFFORT_LABELS[effort]}</span>;
}

function AddAffordance({ loading }: { loading?: boolean }) {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200" aria-hidden="true">
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
    </span>
  );
}

function ManageAffordance() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-gray-700">
      Manage <ArrowRight className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

function AddedPill() {
  return (
    <span className={`${PILL_CLASSES} gap-1 bg-emerald-50 text-emerald-700`}>
      <Check className="h-3 w-3" aria-hidden="true" /> Added
    </span>
  );
}

function GroupHeader({ children }: { children: string }) {
  return <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">{children}</h4>;
}

export function ConnectorQuickAddGrid({
  connections,
  presets,
  onSelect,
  filter,
  onManage,
  onInstantAdd,
  instantAddingPresetId,
}: {
  connections: ExternalMcpConnection[];
  presets: ExternalMcpPreset[];
  onSelect: (id: string) => void;
  filter: string;
  onManage: (connectionId: string) => void;
  onInstantAdd: (preset: ExternalMcpPreset) => void;
  instantAddingPresetId: string | null;
}) {
  const normalizedFilter = filter.trim().toLowerCase();
  const matchesFilter = (displayName: string, description: string, id: string) => (
    !normalizedFilter
    || displayName.toLowerCase().includes(normalizedFilter)
    || description.toLowerCase().includes(normalizedFilter)
    || id.toLowerCase().includes(normalizedFilter)
  );
  const suites = SUITE_CONNECTORS.filter((suite) => matchesFilter(suite.displayName, suite.description, suite.id));
  const filteredPresets = presets.filter((preset) => matchesFilter(preset.displayName, preset.description, preset.presetId));
  const microsoftConfigured = connections.some((connection) => connection.id === MICROSOFT_365_QUICK_ADD_ID);

  if (normalizedFilter && suites.length === 0 && filteredPresets.length === 0) {
    return <p className="text-[13px] text-gray-400" data-testid="connector-quick-add-grid">No connectors match &quot;{filter}&quot;.</p>;
  }

  return (
    <div className="space-y-6" data-testid="connector-quick-add-grid">
      {suites.length > 0 ? (
        <section>
          <GroupHeader>From your workspace suite</GroupHeader>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {suites.map((suite) => {
              const showManage = suite.id === MICROSOFT_365_QUICK_ADD_ID && microsoftConfigured;
              return (
                <button
                  key={suite.id}
                  type="button"
                  data-testid={suite.id === MICROSOFT_365_QUICK_ADD_ID ? "quick-add-microsoft-365" : undefined}
                  onClick={() => onSelect(suite.id)}
                  className="rounded-2xl border border-gray-100 bg-white p-3.5 text-left transition hover:border-gray-300 hover:shadow-xs"
                >
                  <div className="flex items-start gap-2.5">
                    <IntegrationIcon
                      name={suite.displayName}
                      iconUrl={suite.iconUrl}
                      simpleIconSlug={suite.simpleIconSlug}
                      className="h-9 w-9 rounded-[11px]"
                      imageClassName="h-[18px] w-[18px]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold leading-[18px] text-gray-900">{suite.displayName}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-gray-500" title={suite.description}>
                        {suite.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <EffortPill effort="guided" />
                    {showManage ? <ManageAffordance /> : <AddAffordance />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {filteredPresets.length > 0 ? (
        <section>
          <GroupHeader>MCP servers</GroupHeader>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPresets.map((preset) => {
              const connection = connections.find((entry) => entry.url === preset.url);
              const effort = presetEffort(preset);
              const instantAdding = instantAddingPresetId === preset.presetId;
              return (
                <button
                  key={preset.presetId}
                  type="button"
                  data-testid={`quick-add-preset-${preset.presetId}`}
                  onClick={() => {
                    if (connection) onManage(connection.id);
                    else if (instantAdding) return;
                    else if (effort === "instant") onInstantAdd(preset);
                    else onSelect(preset.presetId);
                  }}
                  className={`rounded-2xl border bg-white p-3.5 text-left transition hover:border-gray-300 hover:shadow-xs ${
                    connection ? "border-emerald-200" : "border-gray-100"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <IntegrationIcon
                      name={preset.displayName}
                      serviceUrl={preset.url}
                      className="h-9 w-9 rounded-[11px]"
                      imageClassName="h-[18px] w-[18px]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold leading-[18px] text-gray-900">{preset.displayName}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-gray-500" title={preset.description}>
                        {preset.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    {connection ? <AddedPill /> : <EffortPill effort={effort} />}
                    {connection ? <ManageAffordance /> : <AddAffordance loading={instantAdding} />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

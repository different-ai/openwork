"use client";

import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";
import { IntegrationIcon } from "./integration-icon";

export const GOOGLE_WORKSPACE_QUICK_ADD_ID = "google-workspace";
export const MICROSOFT_365_QUICK_ADD_ID = "microsoft-365";
export const TELEGRAM_QUICK_ADD_ID = "telegram";

export function ConnectorQuickAddGrid({
  connections,
  presets,
  telegramConnected,
  onSelect,
}: {
  connections: ExternalMcpConnection[];
  presets: ExternalMcpPreset[];
  telegramConnected: boolean;
  onSelect: (id: string) => void;
}) {
  const googleConfigured = connections.some((connection) => connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID);
  const microsoftConfigured = connections.some((connection) => connection.id === MICROSOFT_365_QUICK_ADD_ID);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="connector-quick-add-grid">
      <button
        type="button"
        onClick={() => onSelect(GOOGLE_WORKSPACE_QUICK_ADD_ID)}
        className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
      >
        <div className="flex items-start gap-3">
          <IntegrationIcon name="Google Workspace" iconUrl="/integrations/google.svg" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">Google Workspace</p>
            <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
              Your company&apos;s Google. Set it up once — every member connects their own account.
            </p>
          </div>
        </div>
        <p className="mt-2 text-[12px] font-medium text-gray-900">
          {googleConfigured ? "Configured — tap to update" : "Tap to set up"}
        </p>
      </button>

      <button
        type="button"
        data-testid="quick-add-microsoft-365"
        onClick={() => onSelect(MICROSOFT_365_QUICK_ADD_ID)}
        className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
      >
        <div className="flex items-start gap-3">
          <IntegrationIcon name="Microsoft 365" simpleIconSlug="microsoft" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">Microsoft 365</p>
            <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
              Outlook mail, calendar, and OneDrive. Each teammate connects their own work account.
            </p>
          </div>
        </div>
        <p className="mt-2 text-[12px] font-medium text-gray-900">
          {microsoftConfigured ? "Configured — tap to update" : "Tap to set up"}
        </p>
      </button>

      <button
        type="button"
        data-testid="quick-add-telegram"
        onClick={() => onSelect(TELEGRAM_QUICK_ADD_ID)}
        className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm"
      >
        <div className="flex items-start gap-3">
          <IntegrationIcon name="Telegram" simpleIconSlug="telegram" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-gray-900">Telegram</p>
            <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">
              Pair a private Telegram chat to a cloud worker for tasks and replies.
            </p>
          </div>
        </div>
        <p className="mt-2 text-[12px] font-medium text-gray-900">
          {telegramConnected ? "Connected — tap to manage" : "Tap to set up"}
        </p>
      </button>

      {presets.map((preset) => {
        const alreadyAdded = connections.some((connection) => connection.url === preset.url);
        return (
          <button
            key={preset.presetId}
            type="button"
            disabled={alreadyAdded}
            onClick={() => onSelect(preset.presetId)}
            className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left transition hover:border-gray-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="flex items-start gap-3">
              <IntegrationIcon name={preset.displayName} serviceUrl={preset.url} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-gray-900">{preset.displayName}</p>
                <p className="mt-1 text-[12px] leading-[1.5] text-gray-500">{preset.description}</p>
              </div>
            </div>
            <p className="mt-2 text-[12px] font-medium text-gray-900">
              {alreadyAdded ? "Already added" : "Tap to add"}
            </p>
          </button>
        );
      })}
    </div>
  );
}

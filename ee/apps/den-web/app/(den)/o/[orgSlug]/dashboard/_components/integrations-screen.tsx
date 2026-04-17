"use client";

import { useState } from "react";
import { Cable, Check, GitBranch, Unplug } from "lucide-react";
import { DenButton } from "../../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { IntegrationConnectDialog } from "./integration-connect-dialog";
import {
  type ConnectedIntegration,
  type IntegrationProvider,
  INTEGRATION_PROVIDERS,
  formatIntegrationTimestamp,
  useDisconnectIntegration,
  useIntegrations,
} from "./integration-data";

export function IntegrationsScreen() {
  const { data: connections = [], isLoading, error } = useIntegrations();
  const disconnect = useDisconnectIntegration();
  const [dialogProvider, setDialogProvider] = useState<IntegrationProvider | null>(null);

  const connectedByProvider = connections.reduce<
    Partial<Record<IntegrationProvider, ConnectedIntegration[]>>
  >((acc, connection) => {
    const list = acc[connection.provider] ?? [];
    list.push(connection);
    acc[connection.provider] = list;
    return acc;
  }, {});

  const providers = Object.values(INTEGRATION_PROVIDERS);

  return (
    <DashboardPageTemplate
      icon={Cable}
      badgeLabel="Preview"
      title="Integrations"
      description="Connect to GitHub or Bitbucket. Once an account is linked, plugins and skills from those repositories show up on the Plugins page."
      colors={["#E0F2FE", "#0C4A6E", "#0284C7", "#7DD3FC"]}
    >
      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load integrations."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading integrations…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {providers.map((meta) => {
            const providerConnections = connectedByProvider[meta.provider] ?? [];
            const isConnected = providerConnections.length > 0;

            return (
              <div
                key={meta.provider}
                className="overflow-hidden rounded-2xl border border-gray-100 bg-white"
              >
                {/* Header */}
                <div className="flex items-start gap-4 border-b border-gray-100 px-6 py-5">
                  <ProviderLogo provider={meta.provider} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-gray-900">{meta.name}</h2>
                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          <Check className="h-3 w-3" />
                          Connected
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                          Not connected
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] leading-[1.55] text-gray-500">{meta.description}</p>
                  </div>

                  <div className="shrink-0">
                    <DenButton
                      variant={isConnected ? "secondary" : "primary"}
                      size="sm"
                      onClick={() => setDialogProvider(meta.provider)}
                    >
                      {isConnected ? "Connect another" : "Connect"}
                    </DenButton>
                  </div>
                </div>

                {/* Body: connected accounts + repos */}
                {isConnected ? (
                  <div className="grid gap-3 px-6 py-5">
                    {providerConnections.map((connection) => (
                      <ConnectionRow
                        key={connection.id}
                        connection={connection}
                        onDisconnect={() => disconnect.mutate(connection.id)}
                        busy={disconnect.isPending && disconnect.variables === connection.id}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-5 text-[13px] text-gray-400">
                    Requires scopes: {meta.scopes.map((scope) => (
                      <code
                        key={scope}
                        className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600"
                      >
                        {scope}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <IntegrationConnectDialog
        open={dialogProvider !== null}
        provider={dialogProvider}
        onClose={() => setDialogProvider(null)}
      />
    </DashboardPageTemplate>
  );
}

function ConnectionRow({
  connection,
  onDisconnect,
  busy,
}: {
  connection: ConnectedIntegration;
  onDisconnect: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0f172a] text-[11px] font-semibold text-white">
            {connection.account.avatarInitial}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-gray-900">{connection.account.name}</p>
            <p className="truncate text-[12px] text-gray-400">
              {connection.account.kind === "user" ? "Personal" : "Organization"} · Connected{" "}
              {formatIntegrationTimestamp(connection.connectedAt)}
            </p>
          </div>
        </div>

        <DenButton
          variant="destructive"
          size="sm"
          icon={Unplug}
          loading={busy}
          onClick={onDisconnect}
        >
          Disconnect
        </DenButton>
      </div>

      {connection.repos.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {connection.repos.map((repo) => (
            <span
              key={repo.id}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600"
            >
              <GitBranch className="h-3 w-3 text-gray-400" />
              {repo.fullName}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProviderLogo({ provider }: { provider: IntegrationProvider }) {
  if (provider === "github") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#0f172a] text-[13px] font-semibold text-white">
        GH
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#2684FF] text-[13px] font-semibold text-white">
      BB
    </div>
  );
}

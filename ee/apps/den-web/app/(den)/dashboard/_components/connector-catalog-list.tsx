"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, MessageCircle, MinusCircle, MoreHorizontal, Plus, Settings } from "lucide-react";
import {
  configuredConnectionForPopular,
  connectionForPresetUrl,
  connectorChatDeepLink,
  connectorChatPrompt,
  connectorMatchesFilter,
  GOOGLE_WORKSPACE_QUICK_ADD_ID,
  MICROSOFT_365_QUICK_ADD_ID,
  MORE_CONNECTORS_TEASER,
  POPULAR_CONNECTORS,
  remainingPresets,
  type PopularConnector,
} from "./connector-catalog";
import { IntegrationIcon } from "./integration-icon";
import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";

const CONFIGURED_STRIP_LIMIT = 12;

type CatalogRowIcon = { iconUrl?: string; simpleIconSlug?: string; serviceUrl?: string };

export type ConnectorCatalogProps = {
  connections: ExternalMcpConnection[];
  presets: ExternalMcpPreset[];
  filter: string;
  configuredHref: string;
  configuredConnectionHref: (connectionId: string) => string;
  /**
   * Detail page for a row. Receives the connection id when the row is
   * configured, otherwise the catalog id (popular id, preset id, or
   * `microsoft-365`), matching what the detail route resolves.
   */
  connectorHref: (connectorId: string) => string;
  onAddPopular: (connector: PopularConnector) => void;
  onAddPreset: (preset: ExternalMcpPreset) => void;
  onAddMicrosoft365: () => void;
  onManage: (connection: ExternalMcpConnection) => void;
  onRemove: (connection: ExternalMcpConnection) => void;
  addingPresetId: string | null;
};

/**
 * ConnectorChatLink
 *
 * "Chat" hands off to the desktop app: the deep link lands on a new chat with
 * the connector chip and its starter prompt already in the composer.
 */
export function connectorChatHref(displayName: string): string {
  return connectorChatDeepLink({ connector: displayName, prompt: connectorChatPrompt(displayName) });
}

function RowMenu({
  name,
  connection,
  onManage,
  onRemove,
}: {
  name: string;
  connection: ExternalMcpConnection;
  onManage: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const canRemove = connection.id !== GOOGLE_WORKSPACE_QUICK_ADD_ID;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const itemClass = "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] text-gray-700 transition hover:bg-gray-50 hover:text-gray-900";

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
        aria-label={`Options for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`connector-options-${connection.id}`}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={`Options for ${name}`}
          className="absolute right-0 top-10 z-30 w-52 overflow-hidden rounded-2xl border border-gray-100 bg-white p-1.5 shadow-xl shadow-gray-900/10"
        >
          <a
            role="menuitem"
            href={connectorChatHref(name)}
            onClick={() => setOpen(false)}
            className={itemClass}
            data-testid={`connector-chat-${connection.id}`}
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Chat
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className={itemClass}
            data-testid={`connector-manage-${connection.id}`}
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
            Manage
          </button>
          {canRemove ? (
            <>
              <div className="my-1 border-t border-gray-100" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onRemove();
                }}
                className={`${itemClass} text-red-600 hover:bg-red-50 hover:text-red-700`}
                data-testid={`connector-uninstall-${connection.id}`}
              >
                <MinusCircle className="h-4 w-4" aria-hidden="true" />
                Uninstall
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CatalogRow({
  id,
  name,
  description,
  icon,
  connection,
  href,
  adding,
  onAdd,
  onManage,
  onRemove,
}: {
  id: string;
  name: string;
  description: string;
  icon: CatalogRowIcon;
  connection: ExternalMcpConnection | undefined;
  href: string;
  adding: boolean;
  onAdd: () => void;
  onManage: (connection: ExternalMcpConnection) => void;
  onRemove: (connection: ExternalMcpConnection) => void;
}) {
  return (
    <div className="group flex items-center gap-1 py-1" data-testid={`connector-row-${id}`}>
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center gap-3.5 rounded-2xl px-2 py-1.5 transition hover:bg-gray-50"
        data-testid={`connector-open-${id}`}
      >
        <IntegrationIcon
          name={name}
          iconUrl={icon.iconUrl}
          simpleIconSlug={icon.simpleIconSlug}
          serviceUrl={icon.serviceUrl}
          className="h-12 w-12 rounded-[14px]"
          imageClassName="h-6 w-6"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium leading-5 text-gray-900">{name}</span>
          <span className="block truncate text-[13px] leading-5 text-gray-500" title={description}>{description}</span>
        </span>
      </Link>
      {connection ? (
        <RowMenu
          name={name}
          connection={connection}
          onManage={() => onManage(connection)}
          onRemove={() => onRemove(connection)}
        />
      ) : (
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          className="flex h-9 w-9 items-center justify-center rounded-full text-gray-700 transition hover:bg-gray-100 hover:text-gray-900 disabled:cursor-wait"
          aria-label={`Add ${name}`}
          data-testid={`connector-add-${id}`}
        >
          {adding ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Plus className="h-5 w-5" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[15px] font-semibold text-gray-900">{children}</h3>;
}

export function ConfiguredConnectorStrip({
  connections,
  href,
  connectionHref,
}: {
  connections: ExternalMcpConnection[];
  href: string;
  connectionHref: (connectionId: string) => string;
}) {
  const shown = connections.slice(0, CONFIGURED_STRIP_LIMIT);
  const overflow = connections.length - shown.length;

  return (
    <section className="mb-8" data-testid="configured-connector-strip">
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-[15px] font-semibold text-gray-900 transition hover:text-gray-600"
        data-testid="configured-connectors-link"
      >
        Configured
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      {shown.length === 0 ? (
        <p className="mt-2 text-[13px] text-gray-500">Nothing configured yet. Add a connector below and it shows up here.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {shown.map((connection) => (
            <Link
              key={connection.id}
              href={connectionHref(connection.id)}
              title={connection.name}
              aria-label={`Manage ${connection.name}`}
              className="rounded-[14px] transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <IntegrationIcon
                name={connection.name}
                serviceUrl={connection.url}
                className="h-12 w-12 rounded-[14px]"
                imageClassName="h-6 w-6"
              />
            </Link>
          ))}
          {overflow > 0 ? (
            <Link
              href={href}
              className="flex h-12 w-12 items-center justify-center rounded-[14px] border border-gray-100 bg-gray-50 text-[12px] font-semibold text-gray-600"
            >
              +{overflow}
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function ConnectorCatalog({
  connections,
  presets,
  filter,
  configuredHref,
  configuredConnectionHref,
  connectorHref,
  onAddPopular,
  onAddPreset,
  onAddMicrosoft365,
  onManage,
  onRemove,
  addingPresetId,
}: ConnectorCatalogProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const filtering = filter.trim().length > 0;
  const popular = POPULAR_CONNECTORS.filter((connector) =>
    connectorMatchesFilter(filter, connector.displayName, connector.description, connector.id));
  const more = remainingPresets(presets).filter((preset) =>
    connectorMatchesFilter(filter, preset.displayName, preset.description, preset.presetId));
  const microsoftVisible = connectorMatchesFilter(filter, "Microsoft 365", "Outlook Email", "Outlook", "OneDrive", "microsoft-365");
  const microsoftConnection = connections.find((connection) => connection.id === MICROSOFT_365_QUICK_ADD_ID || connection.nativeProviderKey === "microsoft-365");
  const showMore = filtering || moreOpen;
  const nothingMatches = filtering && popular.length === 0 && more.length === 0 && !microsoftVisible;

  return (
    <div data-testid="connector-catalog">
      {!filtering ? (
        <ConfiguredConnectorStrip connections={connections} href={configuredHref} connectionHref={configuredConnectionHref} />
      ) : null}

      {nothingMatches ? (
        <p className="text-[13px] text-gray-400">No connectors match &quot;{filter}&quot;. Paste an MCP server URL to add it directly.</p>
      ) : null}

      {popular.length > 0 ? (
        <section className="mb-8" data-testid="popular-connectors">
          <SectionTitle>Popular</SectionTitle>
          <div className="grid gap-x-8 sm:grid-cols-2">
            {popular.map((connector) => {
              const connection = configuredConnectionForPopular(connector, connections, presets);
              const adding = connector.target.kind === "preset" && addingPresetId === connector.target.presetId;
              return (
                <CatalogRow
                  key={connector.id}
                  id={connector.id}
                  name={connector.displayName}
                  description={connector.description}
                  icon={connector.icon}
                  connection={connection}
                  href={connectorHref(connection?.id ?? connector.id)}
                  adding={adding}
                  onAdd={() => onAddPopular(connector)}
                  onManage={onManage}
                  onRemove={onRemove}
                />
              );
            })}
          </div>
          {!showMore ? (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className="mt-3 inline-flex items-center gap-3 rounded-2xl px-2 py-2 text-[15px] text-gray-700 transition hover:bg-gray-50 hover:text-gray-900"
              data-testid="connector-catalog-more"
            >
              <span className="flex -space-x-2">
                <IntegrationIcon name="Microsoft 365" simpleIconSlug="microsoft" className="h-7 w-7 rounded-[8px]" imageClassName="h-3.5 w-3.5" />
                <IntegrationIcon name="Granola" serviceUrl="https://mcp.granola.ai/mcp" className="h-7 w-7 rounded-[8px]" imageClassName="h-3.5 w-3.5" />
                <IntegrationIcon name="Linear" serviceUrl="https://mcp.linear.app/mcp" className="h-7 w-7 rounded-[8px]" imageClassName="h-3.5 w-3.5" />
              </span>
              {MORE_CONNECTORS_TEASER}
            </button>
          ) : null}
        </section>
      ) : null}

      {showMore && (more.length > 0 || microsoftVisible) ? (
        <section className="mb-8" data-testid="more-connectors">
          <SectionTitle>More connectors</SectionTitle>
          <div className="grid gap-x-8 sm:grid-cols-2">
            {microsoftVisible ? (
              <CatalogRow
                id={MICROSOFT_365_QUICK_ADD_ID}
                name="Microsoft 365"
                description="Outlook email, calendar, and OneDrive"
                icon={{ simpleIconSlug: "microsoft" }}
                connection={microsoftConnection}
                href={connectorHref(microsoftConnection?.id ?? MICROSOFT_365_QUICK_ADD_ID)}
                adding={false}
                onAdd={onAddMicrosoft365}
                onManage={onManage}
                onRemove={onRemove}
              />
            ) : null}
            {more.map((preset) => (
              <CatalogRow
                key={preset.presetId}
                id={preset.presetId}
                name={preset.displayName}
                description={preset.description}
                icon={{ serviceUrl: preset.url }}
                connection={connectionForPresetUrl(connections, preset.url)}
                href={connectorHref(connectionForPresetUrl(connections, preset.url)?.id ?? preset.presetId)}
                adding={addingPresetId === preset.presetId}
                onAdd={() => onAddPreset(preset)}
                onManage={onManage}
                onRemove={onRemove}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

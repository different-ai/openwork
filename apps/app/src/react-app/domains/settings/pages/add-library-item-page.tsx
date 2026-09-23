/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { FileText, Loader2, Plus, Server, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "../../../../i18n";
import { TextInput } from "../../../design-system/text-input";
import { createDenClient, readDenSettings } from "../../../../app/lib/den";
import {
  emptyLibraryMcpConnectionForm,
  libraryMcpConnectionFormIncomplete,
  slugifyLibraryItemName,
  withLibraryMcpAuthType,
  type CreateLibraryItemInput,
  type LibraryAuthorableKind,
  type LibraryMcpAuthType,
  type LibraryMcpConnectionForm,
  type LibraryMcpCredentialMode,
  type LibraryPluginComponentDraft,
  type LibraryPluginComponentKind,
} from "../library";
import { LibraryPage } from "./library-page";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fill well only — no stacked border + inset ring (those look like a double edge in-app). */
const libraryFieldClass = [
  "rounded-xl border-transparent bg-dls-hover shadow-none ring-0",
  "before:hidden before:shadow-none",
  "focus:border-transparent focus:ring-0",
  "focus-visible:border-transparent focus-visible:ring-0",
].join(" ");

type MarketplaceOption = { id: string; name: string };

export type AddLibraryItemPageProps = {
  kind: LibraryAuthorableKind;
  busy?: boolean;
  cloud?: boolean;
  /** Owners and admins can configure a plugin's MCP connection inline; Den refuses it from members. */
  canConfigureMcpConnections?: boolean;
  onClose: () => void;
  onCreate: (input: CreateLibraryItemInput) => Promise<string>;
};

function titleForKind(kind: LibraryAuthorableKind) {
  switch (kind) {
    case "skill":
      return t("extensions.create_skill_title");
    case "command":
      return t("extensions.create_command_title");
    case "agent":
      return t("extensions.create_agent_title");
    case "mcp":
      return t("extensions.create_mcp_title");
    case "plugin":
      return t("extensions.create_plugin_title");
  }
}

function nameHintForKind(kind: LibraryAuthorableKind) {
  switch (kind) {
    case "skill":
      return t("extensions.add_name_hint_skill");
    case "command":
      return t("extensions.add_name_hint_command");
    case "agent":
      return t("extensions.add_name_hint_agent");
    case "mcp":
      return t("extensions.add_name_hint_mcp");
    case "plugin":
      return t("extensions.add_name_hint_plugin");
  }
}

function bodyLabelForKind(kind: Exclude<LibraryAuthorableKind, "plugin" | "mcp">) {
  if (kind === "skill") return t("extensions.add_skill_body_label");
  if (kind === "command") return t("extensions.add_command_body_label");
  return t("extensions.add_agent_body_label");
}

function emptyComponent(kind: LibraryPluginComponentKind, withConnection: boolean): LibraryPluginComponentDraft {
  return {
    kind,
    name: "",
    description: "",
    content: "",
    ...(kind === "mcp" && withConnection ? { connection: emptyLibraryMcpConnectionForm() } : {}),
  };
}

function ChoicePills<TValue extends string>(props: {
  label: string;
  options: Array<{ value: TValue; label: string }>;
  value: TValue;
  disabled: boolean;
  onChange: (value: TValue) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-dls-secondary">{props.label}</div>
      <div role="group" aria-label={props.label} className="flex flex-wrap gap-1.5">
        {props.options.map((option) => {
          const selected = option.value === props.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={props.disabled}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                selected ? "bg-foreground text-background" : "bg-dls-hover text-dls-secondary hover:text-dls-text"
              }`}
              onClick={() => props.onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RadioOption(props: {
  selected: boolean;
  label: string;
  hint: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      className="flex w-full items-start gap-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
      onClick={props.onSelect}
    >
      <span
        className={`mt-0.5 size-4 shrink-0 rounded-full ${
          props.selected ? "border-[5px] border-foreground" : "border-[1.5px] border-muted-foreground/50"
        }`}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-dls-text">{props.label}</span>
        <span className="block text-xs text-dls-secondary">{props.hint}</span>
      </span>
    </button>
  );
}

/**
 * How the server signs in. Whose account the AI uses only matters once other
 * people can use it, so that question waits until the item is shared.
 */
function McpConnectionFields(props: {
  connection: LibraryMcpConnectionForm;
  shared: boolean;
  disabled: boolean;
  onChange: (update: (connection: LibraryMcpConnectionForm) => LibraryMcpConnectionForm) => void;
}) {
  const { connection, disabled, onChange } = props;
  const authOptions: Array<{ value: LibraryMcpAuthType; label: string; hint: string }> = [
    { value: "oauth", label: t("extensions.add_mcp_auth_oauth"), hint: t("extensions.add_mcp_auth_oauth_hint") },
    { value: "apikey", label: t("extensions.add_mcp_auth_apikey"), hint: t("extensions.add_mcp_auth_apikey_hint") },
    { value: "none", label: t("extensions.add_mcp_auth_none"), hint: t("extensions.add_mcp_auth_none_hint") },
  ];
  const accountOptions: Array<{ value: LibraryMcpCredentialMode; label: string }> = [
    { value: "per_member", label: t("extensions.add_mcp_account_per_member") },
    { value: "shared", label: t("extensions.add_mcp_account_shared") },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t("extensions.add_mcp_auth_label")}>
        <div className="mb-1 text-xs font-medium text-dls-secondary">{t("extensions.add_mcp_auth_label")}</div>
        {authOptions.map((option) => (
          <RadioOption
            key={option.value}
            selected={connection.authType === option.value}
            label={option.label}
            hint={option.hint}
            disabled={disabled}
            onSelect={() => onChange((current) => withLibraryMcpAuthType(current, option.value))}
          />
        ))}
      </div>
      {connection.authType === "apikey" ? (
        <TextInput
          label={t("extensions.add_mcp_api_key_label")}
          hint={t("extensions.add_mcp_api_key_hint")}
          type="password"
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={connection.apiKey}
          disabled={disabled}
          placeholder="sk-..."
          className={libraryFieldClass}
          onChange={(event) => {
            const apiKey = event.currentTarget.value;
            onChange((current) => ({ ...current, apiKey }));
          }}
        />
      ) : null}
      {connection.authType === "oauth" && !connection.useOAuthClient ? (
        <button
          type="button"
          disabled={disabled}
          className="self-start text-xs font-medium text-dls-secondary underline underline-offset-4 hover:text-dls-text"
          onClick={() => onChange((current) => ({ ...current, useOAuthClient: true }))}
        >
          {t("extensions.add_mcp_oauth_app_toggle")}
        </button>
      ) : null}
      {connection.authType === "oauth" && connection.useOAuthClient ? (
        <div className="flex flex-col gap-3 rounded-xl bg-dls-hover/60 p-4">
          <p className="text-xs text-dls-secondary">{t("extensions.add_mcp_oauth_app_hint")}</p>
          <TextInput
            label={t("extensions.add_mcp_oauth_client_id_label")}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={connection.oauthClientId}
            disabled={disabled}
            className={libraryFieldClass}
            onChange={(event) => {
              const oauthClientId = event.currentTarget.value;
              onChange((current) => ({ ...current, oauthClientId }));
            }}
          />
          <TextInput
            label={t("extensions.add_mcp_oauth_client_secret_label")}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={connection.oauthClientSecret}
            disabled={disabled}
            className={libraryFieldClass}
            onChange={(event) => {
              const oauthClientSecret = event.currentTarget.value;
              onChange((current) => ({ ...current, oauthClientSecret }));
            }}
          />
        </div>
      ) : null}
      {connection.authType === "oauth" && props.shared ? (
        <div>
          <ChoicePills
            label={t("extensions.add_mcp_account_label")}
            options={accountOptions}
            value={connection.credentialMode}
            disabled={disabled}
            onChange={(credentialMode) => onChange((current) => ({ ...current, credentialMode }))}
          />
          <p className="mt-1.5 text-xs text-dls-secondary">
            {connection.credentialMode === "per_member"
              ? t("extensions.add_mcp_account_per_member_hint")
              : t("extensions.add_mcp_account_shared_hint")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const COMPONENT_META: Record<LibraryPluginComponentKind, { label: string; hint: string }> = {
  skill: {
    label: "Skill",
    hint: "Step-by-step instructions the agent loads when the task matches.",
  },
  command: {
    label: "Command",
    hint: "A reusable slash command. Describe exactly what the agent should do when it runs.",
  },
  agent: {
    label: "Agent",
    hint: "A specialist the composer can switch to for this kind of work.",
  },
  mcp: {
    label: "MCP server",
    hint: "Connect a remote MCP server by URL.",
  },
};

export function AddLibraryItemPage(props: AddLibraryItemPageProps) {
  const kind = props.kind;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [components, setComponents] = useState<LibraryPluginComponentDraft[]>([]);
  const [connection, setConnection] = useState<LibraryMcpConnectionForm>(emptyLibraryMcpConnectionForm);
  const [shareOrgWide, setShareOrgWide] = useState(false);
  const [marketplaceId, setMarketplaceId] = useState("");
  const [marketplaces, setMarketplaces] = useState<MarketplaceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const configureConnections = props.cloud === true && props.canConfigureMcpConnections === true;

  useEffect(() => {
    setName("");
    setDescription("");
    setInstructions("");
    setComponents([]);
    setConnection(emptyLibraryMcpConnectionForm());
    setShareOrgWide(false);
    setMarketplaceId("");
    setError(null);
    setSubmitting(false);
  }, [kind]);

  useEffect(() => {
    if (!props.cloud || kind !== "plugin") return;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) return;
    let cancelled = false;
    void createDenClient({
      baseUrl: settings.baseUrl,
      token,
    }).listOrgMarketplaces(orgId).then((items) => {
      if (!cancelled) {
        setMarketplaces(items.map((item) => ({ id: item.id, name: item.name })));
      }
    }).catch(() => {
      if (!cancelled) setMarketplaces([]);
    });
    return () => {
      cancelled = true;
    };
  }, [props.cloud, kind]);

  const handleClose = () => {
    if (submitting) return;
    props.onClose();
  };

  const updateComponent = (index: number, patch: Partial<LibraryPluginComponentDraft>) => {
    setComponents((current) => current.map((component, currentIndex) => (
      currentIndex === index ? { ...component, ...patch } : component
    )));
  };

  const updateComponentConnection = (
    index: number,
    update: (connection: LibraryMcpConnectionForm) => LibraryMcpConnectionForm,
  ) => {
    setComponents((current) => current.map((component, currentIndex) => (
      currentIndex === index && component.connection
        ? { ...component, connection: update(component.connection) }
        : component
    )));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("extensions.add_name_required"));
      return;
    }
    if (kind === "skill" && (!SKILL_NAME_PATTERN.test(trimmedName) || trimmedName.length > 64)) {
      setError(t("extensions.add_skill_name_invalid"));
      return;
    }
    if (kind === "mcp") {
      if (!instructions.trim()) {
        setError(t("extensions.add_mcp_url_required"));
        return;
      }
      if (configureConnections && libraryMcpConnectionFormIncomplete(connection)) {
        setError(t("extensions.add_mcp_api_key_required"));
        return;
      }
    } else if (kind !== "plugin") {
      if (!description.trim()) {
        setError(t("extensions.add_description_required"));
        return;
      }
      if (!instructions.trim()) {
        setError(t("extensions.add_instructions_required"));
        return;
      }
    }
    if (kind === "plugin") {
      if (components.length === 0) {
        setError(t("extensions.add_plugin_component_required"));
        return;
      }
      for (const component of components) {
        if (!component.name.trim() || !component.content.trim()) {
          setError(t("extensions.add_plugin_component_incomplete"));
          return;
        }
        if (component.connection && libraryMcpConnectionFormIncomplete(component.connection)) {
          setError(t("extensions.add_mcp_api_key_required"));
          return;
        }
      }
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onCreate({
        name: trimmedName,
        description: description.trim(),
        instructions: instructions.trim(),
        orgWide: shareOrgWide,
        marketplaceId: marketplaceId || undefined,
        components: kind === "plugin" ? components : undefined,
        connection: kind === "mcp" && configureConnections ? connection : undefined,
      });
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("common.something_went_wrong"));
    } finally {
      setSubmitting(false);
    }
  };

  const slug = slugifyLibraryItemName(name, kind);
  const busy = submitting || props.busy === true;
  const submitLabel = kind === "plugin"
    ? t("extensions.create_plugin_submit")
    : kind === "skill"
      ? t("extensions.create_skill_submit")
      : kind === "mcp"
        ? t("extensions.create_mcp_submit")
        : t("extensions.add_create");

  return (
    <LibraryPage
      title={titleForKind(kind)}
      testId="library-create-page"
      backDisabled={busy}
      onBack={handleClose}
      footerNote={shareOrgWide ? undefined : t("extensions.add_page_just_me_note")}
      actions={(
        <>
          <Button variant="outline" disabled={busy} onClick={handleClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void handleSubmit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {submitLabel}
          </Button>
        </>
      )}
    >
        {kind === "plugin" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-4">
              <TextInput
                label={t("extensions.add_plugin_name_label")}
                placeholder={t("extensions.add_plugin_name_placeholder")}
                value={name}
                autoFocus
                disabled={busy}
                className={libraryFieldClass}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <label className="block">
                <div className="mb-1 text-xs font-medium text-dls-secondary">
                  {t("extensions.add_description_label")}
                </div>
                <Textarea
                  value={description}
                  disabled={busy}
                  rows={2}
                  placeholder={t("extensions.add_plugin_description_placeholder")}
                  className={libraryFieldClass}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[16px] font-semibold">{t("extensions.add_plugin_inside")}</h2>
                <div className="flex flex-wrap gap-2">
                  {(["skill", "command", "mcp"] as const).map((componentKind) => (
                    <Button
                      key={componentKind}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setComponents((current) => [...current, emptyComponent(componentKind, configureConnections)])}
                    >
                      <Plus size={14} />
                      {COMPONENT_META[componentKind].label}
                    </Button>
                  ))}
                </div>
              </div>
              {components.length === 0 ? (
                <div className="mt-4 rounded-3xl border border-dashed border-dls-border bg-dls-bg px-6 py-10 text-center text-sm text-dls-secondary">
                  {t("extensions.add_plugin_inside_empty")}
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-4">
                  {components.map((component, index) => {
                    const meta = COMPONENT_META[component.kind];
                    const Icon = component.kind === "mcp" ? Server : component.kind === "command" ? Terminal : FileText;
                    return (
                      <div key={`${component.kind}-${index}`} className="rounded-xl bg-dls-hover/60 p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <Icon size={16} className="text-dls-secondary" />
                            {meta.label}
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            className="text-dls-secondary hover:text-red-11"
                            aria-label={`Remove ${meta.label.toLowerCase()}`}
                            onClick={() => setComponents((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <p className="mb-4 text-xs text-dls-secondary">{meta.hint}</p>
                        <div className="flex flex-col gap-3">
                          <TextInput
                            value={component.name}
                            disabled={busy}
                            placeholder={component.kind === "mcp" ? "Server name (e.g. Linear)" : "Name (e.g. Prep a sales call)"}
                            className={libraryFieldClass}
                            onChange={(event) => updateComponent(index, { name: event.currentTarget.value })}
                          />
                          {component.kind !== "mcp" ? (
                            <TextInput
                              value={component.description}
                              disabled={busy}
                              placeholder={t("extensions.add_component_description_placeholder")}
                              className={libraryFieldClass}
                              onChange={(event) => updateComponent(index, { description: event.currentTarget.value })}
                            />
                          ) : null}
                          {component.kind === "mcp" ? (
                            <>
                              <TextInput
                                value={component.content}
                                disabled={busy}
                                placeholder="https://mcp.example.com/mcp"
                                className={libraryFieldClass}
                                onChange={(event) => updateComponent(index, { content: event.currentTarget.value })}
                              />
                              {component.connection ? (
                                <McpConnectionFields
                                  connection={component.connection}
                                  shared={shareOrgWide}
                                  disabled={busy}
                                  onChange={(update) => updateComponentConnection(index, update)}
                                />
                              ) : null}
                            </>
                          ) : (
                            <Textarea
                              value={component.content}
                              disabled={busy}
                              rows={8}
                              className={`font-mono leading-6 ${libraryFieldClass}`}
                              placeholder={
                                component.kind === "skill"
                                  ? t("extensions.add_skill_body_placeholder")
                                  : t("extensions.add_command_body_placeholder")
                              }
                              onChange={(event) => updateComponent(index, { content: event.currentTarget.value })}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {props.cloud ? (
              <div className="flex flex-col gap-4">
                <h2 className="text-[16px] font-semibold">{t("extensions.add_plugin_share")}</h2>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={shareOrgWide}
                    disabled={busy}
                    className="mt-0.5"
                    onChange={(event) => setShareOrgWide(event.currentTarget.checked)}
                  />
                  <span>
                    {t("extensions.add_plugin_share_org")}
                    <span className="block text-xs text-dls-secondary">
                      {t("extensions.add_plugin_share_org_hint")}
                    </span>
                  </span>
                </label>
                <label className="block">
                  <div className="mb-1.5 text-xs font-medium text-dls-secondary">
                    {t("extensions.add_plugin_collection")}
                  </div>
                  <select
                    value={marketplaceId}
                    disabled={busy}
                    className={`w-full px-3 py-2 text-sm ${libraryFieldClass}`}
                    onChange={(event) => setMarketplaceId(event.currentTarget.value)}
                  >
                    <option value="">{t("extensions.add_plugin_collection_none")}</option>
                    {marketplaces.map((marketplace) => (
                      <option key={marketplace.id} value={marketplace.id}>
                        {marketplace.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-xs text-dls-secondary">
                    {t("extensions.add_plugin_collection_hint")}
                  </p>
                </label>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <TextInput
              label={t("extensions.add_name_label")}
              hint={nameHintForKind(kind)}
              value={name}
              autoFocus
              disabled={busy}
              maxLength={64}
              placeholder={kind === "skill" ? "e.g. customer-research" : undefined}
              className={libraryFieldClass}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            {kind !== "skill" && name.trim() && slug !== name.trim() ? (
              <p className="text-xs text-dls-secondary">
                {t("extensions.add_slug_preview", { slug })}
              </p>
            ) : null}
            {kind === "mcp" ? (
              <>
                <TextInput
                  label={t("extensions.add_mcp_url_label")}
                  hint={t("extensions.add_mcp_url_hint")}
                  value={instructions}
                  disabled={busy}
                  placeholder="https://mcp.example.com/mcp"
                  className={libraryFieldClass}
                  onChange={(event) => setInstructions(event.currentTarget.value)}
                />
                {configureConnections ? (
                  <McpConnectionFields
                    connection={connection}
                    shared={shareOrgWide}
                    disabled={busy}
                    onChange={(update) => setConnection(update)}
                  />
                ) : null}
              </>
            ) : (
              <>
                <TextInput
                  label={t("extensions.add_description_label")}
                  hint={kind === "skill" ? t("extensions.add_skill_description_hint") : undefined}
                  value={description}
                  disabled={busy}
                  maxLength={1024}
                  placeholder={kind === "skill" ? t("extensions.add_skill_description_placeholder") : undefined}
                  className={libraryFieldClass}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-dls-secondary">
                    {bodyLabelForKind(kind)}
                  </div>
                  {kind === "skill" ? (
                    <p className="mb-2 text-xs text-dls-secondary">{t("extensions.add_skill_body_hint")}</p>
                  ) : null}
                  <Textarea
                    value={instructions}
                    disabled={busy}
                    rows={kind === "skill" ? 16 : 8}
                    className={kind === "skill" ? `min-h-64 font-mono leading-6 ${libraryFieldClass}` : `min-h-32 ${libraryFieldClass}`}
                    placeholder={kind === "skill" ? t("extensions.add_skill_body_placeholder") : undefined}
                    onChange={(event) => setInstructions(event.currentTarget.value)}
                  />
                </label>
              </>
            )}
            {props.cloud ? (
              <div className="flex flex-col gap-2">
                <h2 className="text-[15px] font-semibold">{t("extensions.add_access_label")}</h2>
                <div role="radiogroup" aria-label={t("extensions.add_access_label")} className="flex flex-col gap-1">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!shareOrgWide}
                    disabled={busy}
                    className={`flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left ${shareOrgWide ? "" : "bg-dls-hover"}`}
                    onClick={() => setShareOrgWide(false)}
                  >
                    <span className={`mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-full ${shareOrgWide ? "border-[1.5px] border-muted-foreground/50" : "bg-foreground"}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{t("extensions.add_access_just_me")}</span>
                      <span className="block text-[13px] text-dls-secondary">{t("extensions.add_access_just_me_hint")}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={shareOrgWide}
                    disabled={busy}
                    className={`flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left ${shareOrgWide ? "bg-dls-hover" : ""}`}
                    onClick={() => setShareOrgWide(true)}
                  >
                    <span className={`mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-full ${shareOrgWide ? "bg-foreground" : "border-[1.5px] border-muted-foreground/50"}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{t("extensions.add_access_everyone")}</span>
                      <span className="block text-[13px] text-dls-secondary">{t("extensions.add_access_everyone_hint")}</span>
                    </span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? (
          <div className="rounded-2xl border border-red-6 bg-red-2 px-4 py-3 text-sm text-red-11">
            {error}
          </div>
        ) : null}
    </LibraryPage>
  );
}

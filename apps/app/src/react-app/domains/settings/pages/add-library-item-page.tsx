/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Check, FileText, Loader2, Plus, Server, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DenExternalMcpPreset } from "../../../../app/lib/den";
import {
  mcpServerChecks,
  mcpServerChecksPassed,
  type DenMcpDiscovery,
  type McpServerCheck,
} from "../../../../app/lib/den-mcp-discovery";
import { t } from "../../../../i18n";
import { TextInput } from "../../../design-system/text-input";
import { resolveExtensionIconUrl } from "../../../design-system/extension-icon-src";
import { IconImage } from "../../../design-system/icon-image";
import {
  emptyLibraryMcpConnectionForm,
  libraryMcpConnectionFormIncomplete,
  withLibraryMcpAuthType,
  type CreateLibraryItemInput,
  type LibraryAuthorableKind,
  type LibraryMcpAuthType,
  type LibraryMcpConnectionForm,
  type LibraryPluginComponentDraft,
  type LibraryPluginComponentKind,
} from "../library";
import { LibraryPage } from "./library-page";
import { McpServerCheckList } from "./mcp-server-check-list";

/** Fill well only — no stacked border + inset ring (those look like a double edge in-app). */
export const libraryFieldClass = [
  "rounded-xl border-transparent bg-dls-hover shadow-none ring-0",
  "before:hidden before:shadow-none",
  "focus:border-transparent focus:ring-0",
  "focus-visible:border-transparent focus-visible:ring-0",
].join(" ");

export type AddLibraryItemPageProps = {
  kind: LibraryAuthorableKind;
  busy?: boolean;
  cloud?: boolean;
  /** Owners and admins can configure a connector's sign-in inline; Den refuses it from members. */
  canConfigureMcpConnections?: boolean;
  /** Connectors a plugin can include without typing an address. */
  connectorPresets?: DenExternalMcpPreset[];
  /** Looks at an MCP server before it is added; the page shows each check and waits for Continue. */
  checkMcpServer?: (url: string) => Promise<DenMcpDiscovery>;
  /** Steps between Library and this page, e.g. Add a connector. */
  crumbs?: Array<{ label: string; onClick?: () => void }>;
  onClose: () => void;
  onCreate: (input: CreateLibraryItemInput) => Promise<unknown>;
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

type McpCheckState =
  | { status: "checking" }
  | { status: "done"; checks: McpServerCheck[]; discovery: DenMcpDiscovery }
  | { status: "unavailable" };

const mcpCheckWords = () => ({
  reachOk: t("extensions.mcp_check_reach_ok"),
  reachFail: t("extensions.mcp_check_reach_fail"),
  protocolOk: (version: string | undefined) => (version
    ? t("extensions.mcp_check_protocol_ok_version", { version })
    : t("extensions.mcp_check_protocol_ok")),
  protocolFail: t("extensions.mcp_check_protocol_fail"),
  signInOauth: t("extensions.mcp_check_sign_in_oauth"),
  signInNone: t("extensions.mcp_check_sign_in_none"),
  signInKey: t("extensions.mcp_check_sign_in_key"),
  signInUnknown: t("extensions.mcp_check_sign_in_unknown"),
  registrationDynamic: t("extensions.mcp_check_registration_dynamic"),
  registrationMetadata: t("extensions.mcp_check_registration_metadata"),
  registrationManual: t("extensions.mcp_check_registration_manual"),
  toolsReady: (count: number) => t("extensions.mcp_check_tools_ready", { count: String(count) }),
  toolsAfterSignIn: t("extensions.mcp_check_tools_after_sign_in"),
  toolsNone: t("extensions.mcp_check_tools_none"),
});

function emptyComponent(kind: LibraryPluginComponentKind, withConnection: boolean): LibraryPluginComponentDraft {
  return {
    kind,
    name: "",
    description: "",
    content: "",
    ...(kind === "mcp" && withConnection ? { connection: emptyLibraryMcpConnectionForm() } : {}),
  };
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

/** How a server signs in. Everything starts as Just me, so the AI always uses the member's own account. */
export function McpConnectionFields(props: {
  connection: LibraryMcpConnectionForm;
  disabled: boolean;
  onChange: (update: (connection: LibraryMcpConnectionForm) => LibraryMcpConnectionForm) => void;
}) {
  const { connection, disabled, onChange } = props;
  const authOptions: Array<{ value: LibraryMcpAuthType; label: string; hint: string }> = [
    { value: "oauth", label: t("extensions.add_mcp_auth_oauth"), hint: t("extensions.add_mcp_auth_oauth_hint") },
    { value: "apikey", label: t("extensions.add_mcp_auth_apikey"), hint: t("extensions.add_mcp_auth_apikey_hint") },
    { value: "none", label: t("extensions.add_mcp_auth_none"), hint: t("extensions.add_mcp_auth_none_hint") },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t("extensions.add_mcp_auth_label")}>
        <div className="mb-1 text-sm font-medium text-dls-text">{t("extensions.add_mcp_auth_label")}</div>
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
    </div>
  );
}

function PresetIcon(props: { preset: DenExternalMcpPreset }) {
  const src = resolveExtensionIconUrl({ iconSlug: props.preset.presetId, serviceUrl: props.preset.url });
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dls-border bg-white">
      <IconImage src={src} size={14} fallback={<Server size={14} className="text-dls-secondary" />} />
    </span>
  );
}

/** Pick a listed connector for a plugin, or type the address of something else. */
function PluginConnectorPicker(props: {
  component: LibraryPluginComponentDraft;
  presets: DenExternalMcpPreset[];
  disabled: boolean;
  withConnection: boolean;
  onChange: (patch: Partial<LibraryPluginComponentDraft>) => void;
}) {
  const [custom, setCustom] = useState(props.presets.length === 0);
  const selected = props.presets.find((preset) => preset.url === props.component.content) ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      {props.presets.map((preset) => {
        const active = selected?.presetId === preset.presetId && !custom;
        return (
          <button
            key={preset.presetId}
            type="button"
            aria-pressed={active}
            disabled={props.disabled}
            className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left ${active ? "bg-dls-surface ring-1 ring-dls-border" : "hover:bg-dls-surface"}`}
            onClick={() => {
              setCustom(false);
              props.onChange({
                name: preset.displayName,
                content: preset.url,
                ...(props.withConnection
                  ? { connection: withLibraryMcpAuthType(emptyLibraryMcpConnectionForm(), preset.authType) }
                  : {}),
              });
            }}
          >
            <PresetIcon preset={preset} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-dls-text">{preset.displayName}</span>
              <span className="block truncate text-xs text-dls-secondary">{preset.description}</span>
            </span>
            {active ? <Check size={14} className="shrink-0 text-dls-text" /> : null}
          </button>
        );
      })}
      {props.presets.length > 0 && !custom ? (
        <button
          type="button"
          disabled={props.disabled}
          className="self-start px-2.5 py-1 text-xs font-medium text-dls-secondary underline underline-offset-4 hover:text-dls-text"
          onClick={() => {
            setCustom(true);
            props.onChange({ name: "", content: "" });
          }}
        >
          {t("extensions.add_connector_something_else")}
        </button>
      ) : null}
      {custom ? (
        <div className="flex flex-col gap-3">
          <TextInput
            value={props.component.name}
            disabled={props.disabled}
            placeholder={t("extensions.add_connector_name_placeholder")}
            className={libraryFieldClass}
            onChange={(event) => props.onChange({ name: event.currentTarget.value })}
          />
          <TextInput
            value={props.component.content}
            disabled={props.disabled}
            placeholder="https://mcp.example.com/mcp"
            className={libraryFieldClass}
            onChange={(event) => props.onChange({ content: event.currentTarget.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

const COMPONENT_ICON: Record<LibraryPluginComponentKind, typeof FileText> = {
  skill: FileText,
  command: Terminal,
  agent: FileText,
  mcp: Server,
};

function componentLabel(kind: LibraryPluginComponentKind) {
  if (kind === "mcp") return t("extensions.kind_connector");
  if (kind === "command") return t("extensions.kind_command");
  if (kind === "agent") return t("extensions.kind_agent");
  return t("extensions.kind_skill");
}

export function AddLibraryItemPage(props: AddLibraryItemPageProps) {
  const kind = props.kind;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [components, setComponents] = useState<LibraryPluginComponentDraft[]>([]);
  const [connection, setConnection] = useState<LibraryMcpConnectionForm>(emptyLibraryMcpConnectionForm);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mcpCheck, setMcpCheck] = useState<McpCheckState | null>(null);
  const [checksSettled, setChecksSettled] = useState(false);
  const configureConnections = props.cloud === true && props.canConfigureMcpConnections === true;
  const presets = props.connectorPresets ?? [];

  useEffect(() => {
    setName("");
    setDescription("");
    setInstructions("");
    setComponents([]);
    setConnection(emptyLibraryMcpConnectionForm());
    setError(null);
    setSubmitting(false);
    setMcpCheck(null);
    setChecksSettled(false);
  }, [kind]);

  const handleClose = () => {
    if (submitting) return;
    props.onClose();
  };

  const updateComponent = (index: number, patch: Partial<LibraryPluginComponentDraft>) => {
    setComponents((current) => current.map((component, currentIndex) => (
      currentIndex === index ? { ...component, ...patch } : component
    )));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("extensions.add_name_required"));
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
        setError(kind === "skill" ? t("extensions.add_skill_when_required") : t("extensions.add_description_required"));
        return;
      }
      if (!instructions.trim()) {
        setError(kind === "skill" ? t("extensions.add_skill_what_required") : t("extensions.add_instructions_required"));
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
      }
    }
    setError(null);
    if (kind === "mcp" && props.checkMcpServer && !mcpCheck) {
      void runMcpCheck(props.checkMcpServer, instructions.trim());
      return;
    }
    await create(connection);
  };

  const runMcpCheck = async (check: (url: string) => Promise<DenMcpDiscovery>, url: string) => {
    setChecksSettled(false);
    setMcpCheck({ status: "checking" });
    try {
      const discovery = await check(url);
      setMcpCheck({ status: "done", discovery, checks: mcpServerChecks(discovery, mcpCheckWords()) });
    } catch {
      setMcpCheck({ status: "unavailable" });
      setChecksSettled(true);
    }
  };

  const create = async (withConnection: LibraryMcpConnectionForm) => {
    setSubmitting(true);
    try {
      await props.onCreate({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        components: kind === "plugin" ? components : undefined,
        connection: kind === "mcp" && configureConnections ? withConnection : undefined,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("common.something_went_wrong"));
      setSubmitting(false);
    }
  };

  /** Den knows better than the form how the server signs in; a keyless server needs no sign-in step. */
  const continueAfterCheck = () => {
    if (mcpCheck?.status === "done" && mcpCheck.discovery.authentication.kind === "none" && connection.authType !== "none") {
      const adjusted = withLibraryMcpAuthType(connection, "none");
      setConnection(adjusted);
      void create(adjusted);
      return;
    }
    void create(connection);
  };

  const busy = submitting || props.busy === true;
  const submitLabel = kind === "plugin"
    ? t("extensions.create_plugin_submit")
    : kind === "skill"
      ? t("extensions.create_skill_submit")
      : kind === "mcp"
        ? configureConnections && connection.authType === "oauth"
          ? t("extensions.create_mcp_submit_sign_in")
          : t("extensions.create_mcp_submit")
        : t("extensions.add_create");

  if (mcpCheck) {
    const serverName = name.trim();
    const checks = mcpCheck.status === "done" ? mcpCheck.checks : null;
    const passed = checks ? mcpServerChecksPassed(checks) : mcpCheck.status === "unavailable";
    const warned = checks?.some((check) => check.status === "warn") === true;
    const heading = mcpCheck.status === "checking" || !checksSettled
      ? t("extensions.mcp_check_title", { name: serverName })
      : !passed
        ? t("extensions.mcp_check_failed", { name: serverName })
        : warned || mcpCheck.status === "unavailable"
          ? t("extensions.mcp_check_done_warn", { name: serverName })
          : t("extensions.mcp_check_done", { name: serverName });
    return (
      <LibraryPage
        title={titleForKind(kind)}
        crumbs={props.crumbs ?? [{ label: titleForKind(kind) }]}
        testId="library-create-page"
        backDisabled={busy}
        onBack={handleClose}
        footerNote={t("extensions.add_page_just_me_note")}
        actions={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => { setMcpCheck(null); setChecksSettled(false); }}>
              {t("extensions.mcp_check_edit")}
            </Button>
            <Button
              disabled={busy || !checksSettled}
              variant={passed ? "default" : "outline"}
              onClick={continueAfterCheck}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {passed ? t("extensions.mcp_check_continue") : t("extensions.mcp_check_add_anyway")}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-1" data-mcp-check-state={checksSettled ? (passed ? "passed" : "failed") : "checking"}>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-dls-text">{heading}</h2>
          <p className="text-[13px] text-dls-secondary">
            {mcpCheck.status === "unavailable" ? t("extensions.mcp_check_unavailable") : t("extensions.mcp_check_hint")}
          </p>
          <p className="truncate font-mono text-xs text-dls-secondary">{instructions.trim()}</p>
        </div>
        {mcpCheck.status === "unavailable" ? null : (
          <McpServerCheckList checks={checks} onSettled={() => setChecksSettled(true)} />
        )}
        {error ? (
          <div role="alert" className="rounded-2xl border border-red-6 bg-red-2 px-4 py-3 text-sm text-red-11">
            {error}
          </div>
        ) : null}
      </LibraryPage>
    );
  }

  return (
    <LibraryPage
      title={titleForKind(kind)}
      crumbs={props.crumbs ?? [{ label: titleForKind(kind) }]}
      testId="library-create-page"
      backDisabled={busy}
      onBack={handleClose}
      footerNote={t("extensions.add_page_just_me_note")}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              label={t("extensions.add_plugin_name_label")}
              placeholder={t("extensions.add_plugin_name_placeholder")}
              value={name}
              autoFocus
              disabled={busy}
              className={libraryFieldClass}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <TextInput
              label={t("extensions.add_description_label")}
              placeholder={t("extensions.add_plugin_description_placeholder")}
              value={description}
              disabled={busy}
              className={libraryFieldClass}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">{t("extensions.add_plugin_inside")}</h2>
              <div className="flex flex-wrap gap-2">
                {(["skill", "command", "mcp"] satisfies LibraryPluginComponentKind[]).map((componentKind) => (
                  <Button
                    key={componentKind}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setComponents((current) => [...current, emptyComponent(componentKind, configureConnections)])}
                  >
                    <Plus size={14} />
                    {componentLabel(componentKind)}
                  </Button>
                ))}
              </div>
            </div>
            {components.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-dls-border px-6 py-8 text-center text-sm text-dls-secondary">
                {t("extensions.add_plugin_inside_empty")}
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {components.map((component, index) => {
                  const Icon = COMPONENT_ICON[component.kind];
                  const label = componentLabel(component.kind);
                  return (
                    <div key={`${component.kind}-${index}`} data-plugin-component={component.kind} className="rounded-xl bg-dls-hover/60 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icon size={15} className="text-dls-secondary" />
                          {component.kind !== "mcp" && component.name.trim() ? `${label} · ${component.name.trim()}` : label}
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          className="text-dls-secondary hover:text-red-11"
                          aria-label={t("extensions.add_plugin_remove_component", { kind: label })}
                          onClick={() => setComponents((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {component.kind === "mcp" ? (
                        <PluginConnectorPicker
                          component={component}
                          presets={presets}
                          disabled={busy}
                          withConnection={configureConnections}
                          onChange={(patch) => updateComponent(index, patch)}
                        />
                      ) : (
                        <div className="flex flex-col gap-2.5">
                          <TextInput
                            value={component.name}
                            disabled={busy}
                            aria-label={t("extensions.add_component_name_label", { kind: label })}
                            placeholder={t("extensions.add_component_name_placeholder")}
                            className={libraryFieldClass}
                            onChange={(event) => updateComponent(index, { name: event.currentTarget.value })}
                          />
                          <TextInput
                            value={component.description}
                            disabled={busy}
                            aria-label={t("extensions.add_skill_when_label")}
                            placeholder={t("extensions.add_component_description_placeholder")}
                            className={libraryFieldClass}
                            onChange={(event) => updateComponent(index, { description: event.currentTarget.value })}
                          />
                          <Textarea
                            value={component.content}
                            disabled={busy}
                            rows={3}
                            aria-label={t("extensions.add_skill_what_label")}
                            className={libraryFieldClass}
                            placeholder={component.kind === "skill"
                              ? t("extensions.add_skill_body_placeholder")
                              : t("extensions.add_command_body_placeholder")}
                            onChange={(event) => updateComponent(index, { content: event.currentTarget.value })}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <TextInput
            label={t("extensions.add_name_label")}
            value={name}
            autoFocus
            disabled={busy}
            maxLength={64}
            placeholder={kind === "skill" ? t("extensions.add_skill_name_placeholder") : kind === "mcp" ? t("extensions.add_connector_name_placeholder") : undefined}
            className={libraryFieldClass}
            onChange={(event) => setName(event.currentTarget.value)}
          />
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
                  disabled={busy}
                  onChange={(update) => setConnection(update)}
                />
              ) : null}
            </>
          ) : (
            <>
              <TextInput
                label={kind === "skill" ? t("extensions.add_skill_when_label") : t("extensions.add_description_label")}
                value={description}
                disabled={busy}
                maxLength={1024}
                placeholder={kind === "skill" ? t("extensions.add_skill_description_placeholder") : undefined}
                className={libraryFieldClass}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
              <label className="block">
                <div className="mb-1 text-sm font-medium text-dls-text">
                  {kind === "skill"
                    ? t("extensions.add_skill_what_label")
                    : kind === "command"
                      ? t("extensions.add_command_body_label")
                      : t("extensions.add_agent_body_label")}
                </div>
                <Textarea
                  value={instructions}
                  disabled={busy}
                  rows={kind === "skill" ? 6 : 8}
                  className={`min-h-32 leading-6 ${libraryFieldClass}`}
                  placeholder={kind === "skill" ? t("extensions.add_skill_body_placeholder") : undefined}
                  onChange={(event) => setInstructions(event.currentTarget.value)}
                />
              </label>
            </>
          )}
        </div>
      )}

      {error ? (
        <div role="alert" className="rounded-2xl border border-red-6 bg-red-2 px-4 py-3 text-sm text-red-11">
          {error}
        </div>
      ) : null}
    </LibraryPage>
  );
}

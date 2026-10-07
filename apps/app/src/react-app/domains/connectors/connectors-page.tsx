/** @jsxImportSource react */
import { useState } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Plug,
  Trash2,
  Zap,
} from "lucide-react";

import { t } from "@/i18n";
import type { McpDirectoryInfo } from "@/app/constants";
import type { McpServerEntry, McpStatusMap } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TextInput } from "@/react-app/design-system/text-input";
import { AddMcpModal } from "@/react-app/domains/connections/modals/add-mcp-modal";
import type { McpConnectResult } from "@/react-app/domains/connections/store";
import type { ReactMcpStatus } from "@/react-app/domains/settings/pages/mcp-view";

// ---------------------------------------------------------------------------
// 测试连接结果
// ---------------------------------------------------------------------------

export type McpTestResult =
  | { ok: true; toolCount: number }
  | {
      ok: false;
      error: string;
      status?:
        | "disabled"
        | "unavailable"
        | "needs_auth"
        | "failed"
        | "not_registered";
    };

type TestResultState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "done"; result: McpTestResult };

// ---------------------------------------------------------------------------
// 飞书平台连接器
// ---------------------------------------------------------------------------

const FEISHU_MCP_NAME = "feishu";
const FEISHU_NPM_PKG = "@larksuiteoapi/lark-mcp";
const FEISHU_CREDS_KEY = "openwork.feishu-mcp.creds";

type FeishuCreds = { appId: string; appSecret: string };

function readFeishuCreds(): FeishuCreds {
  try {
    const raw = window.localStorage.getItem(FEISHU_CREDS_KEY);
    if (!raw) return { appId: "", appSecret: "" };
    const parsed = JSON.parse(raw) as Partial<FeishuCreds>;
    return {
      appId: typeof parsed.appId === "string" ? parsed.appId : "",
      appSecret: typeof parsed.appSecret === "string" ? parsed.appSecret : "",
    };
  } catch {
    return { appId: "", appSecret: "" };
  }
}

function writeFeishuCreds(creds: FeishuCreds): void {
  try {
    window.localStorage.setItem(FEISHU_CREDS_KEY, JSON.stringify(creds));
  } catch {
    // 存储失败不影响连接
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板不可用时静默失败
  }
}

function buildFeishuLoginCommand(creds: FeishuCreds): string[] {
  return ["npx", "-y", FEISHU_NPM_PKG, "login", "-a", creds.appId.trim(), "-s", creds.appSecret.trim()];
}

function buildFeishuCommand(creds: FeishuCreds): string[] {
  return [
    "npx",
    "-y",
    FEISHU_NPM_PKG,
    "mcp",
    "-a",
    creds.appId.trim(),
    "-s",
    creds.appSecret.trim(),
    "-l",
    "zh",
    "-m",
    "stdio",
    "--oauth",
    "--token-mode",
    "user_access_token",
  ];
}

function feishuDirectoryEntry(creds: FeishuCreds): McpDirectoryInfo {
  return {
    name: FEISHU_MCP_NAME,
    type: "local",
    command: buildFeishuCommand(creds),
    oauth: false,
    description: "Feishu/Lark MCP (user-level)",
  };
}

// ---------------------------------------------------------------------------
// 状态展示（镜像 mcp-view.tsx 的 statusDot / friendlyStatus）
// ---------------------------------------------------------------------------

const statusDot = (status: ReactMcpStatus): string => {
  switch (status) {
    case "connected":
      return "bg-green-9";
    case "needs_auth":
    case "reconnect_required":
    case "needs_client_registration":
      return "bg-amber-9";
    case "disabled":
      return "bg-gray-8";
    case "disconnected":
      return "bg-gray-7";
    default:
      return "bg-red-9";
  }
};

const friendlyStatus = (status: ReactMcpStatus): string => {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin");
    case "reconnect_required":
      return t("mcp.friendly_status_reconnect_required");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "disconnected":
      return t("mcp.friendly_status_offline");
    default:
      return t("mcp.friendly_status_issue");
  }
};

const transportBadge = (entry: McpServerEntry): string =>
  entry.config.type === "remote" ? "url" : "stdio";

// ---------------------------------------------------------------------------
// 单个 MCP 卡片的测试结果行
// ---------------------------------------------------------------------------

function TestResultLine({
  name,
  state,
  compact,
}: {
  name: string;
  state?: TestResultState;
  compact?: boolean;
}) {
  if (!state || state.phase === "idle") {
    return (
      <span className="text-xs text-dls-secondary/60">
        {t("connectors.test_idle")}
      </span>
    );
  }
  if (state.phase === "testing") {
    return (
      <span className="flex items-center gap-1 text-xs text-dls-secondary">
        <Loader2 className="size-3 animate-spin" />
        {t("connectors.testing")}
      </span>
    );
  }
  const { result } = state;
  const ok = result.ok;
  const tone = ok ? "text-green-11" : "text-red-11";
  const icon = ok ? (
    <Zap className="size-3.5" />
  ) : result.status === "needs_auth" ? (
    <Plug className="size-3.5" />
  ) : (
    <Trash2 className="size-3.5" />
  );
  const text = ok
    ? t("connectors.test_ok", { count: result.toolCount })
    : `${result.status ?? "failed"}${result.error ? ` · ${result.error}` : ""}`;
  return (
    <span className={`mt-1 flex items-center gap-1 text-xs ${tone}`}>
      {icon}
      <span className="truncate">{text}</span>
      {compact ? null : (
        <span className="text-dls-secondary/60">· {name}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export type ConnectorsPageProps = {
  /** 当前工作区已配置的 MCP（“我的 MCP” 区）。 */
  mcpServers: McpServerEntry[];
  /** 各 MCP 的运行状态。 */
  mcpStatuses: McpStatusMap;
  /** 连接一个 MCP 目录条目。 */
  connectMcp: (entry: McpDirectoryInfo) => Promise<McpConnectResult>;
  /** 启用 / 禁用一个 MCP。 */
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  /** 移除一个 MCP。 */
  removeMcp: (name: string) => void;
  /** 测试一个 MCP 连接，返回结构化结果。 */
  testMcp: (name: string) => Promise<McpTestResult>;
  /** 是否有连接正在进行。 */
  busy?: boolean;
};

export function ConnectorsPage(props: ConnectorsPageProps) {
  const [feishuCreds, setFeishuCreds] = useState<FeishuCreds>(() =>
    readFeishuCreds(),
  );
  const [secretVisible, setSecretVisible] = useState(false);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<string | null>(null);

  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [togglingMcp, setTogglingMcp] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, TestResultState>>(
    {},
  );

  const persistCreds = (next: FeishuCreds) => {
    setFeishuCreds(next);
    writeFeishuCreds(next);
  };

  const feishuInstalled = props.mcpServers.some((entry) => entry.name === FEISHU_MCP_NAME);

  const connectFeishu = async () => {
    setFeishuBusy(true);
    setFeishuStatus(null);
    try {
      const result = await props.connectMcp(feishuDirectoryEntry(feishuCreds));
      if (result.ok) {
        setFeishuStatus(t("connectors.feishu_connected"));
        // 注册后立即探活一次，确认引擎已拉起
        void probe(FEISHU_MCP_NAME);
      } else {
        setFeishuStatus(
          result.error.trim()
            ? result.error
            : t("connectors.feishu_connect_failed"),
        );
      }
    } catch (error) {
      setFeishuStatus(
        error instanceof Error
          ? error.message
          : t("connectors.feishu_connect_failed"),
      );
    } finally {
      setFeishuBusy(false);
    }
  };

  const probe = (name: string) => {
    setTestState((current) => ({ ...current, [name]: { phase: "testing" } }));
    void props.testMcp(name).then(
      (result) => {
        setTestState((current) => ({
          ...current,
          [name]: { phase: "done", result },
        }));
      },
      (error: unknown) => {
        setTestState((current) => ({
          ...current,
          [name]: {
            phase: "done",
            result: {
              ok: false,
              error: error instanceof Error ? error.message : "probe failed",
              status: "unavailable",
            },
          },
        }));
      },
    );
  };

  const toggleEnabled = (name: string, enabled: boolean) => {
    if (!props.setMcpEnabled || togglingMcp) return;
    setTogglingMcp(name);
    void Promise.resolve(props.setMcpEnabled(name, enabled)).finally(() => {
      setTogglingMcp(null);
    });
  };

  return (
    <div
      className="mx-auto w-full max-w-4xl animate-in fade-in duration-300 px-6 py-6"
      data-connectors-page
    >
      <header className="mb-6 flex items-center gap-2">
        <Plug className="size-5 text-dls-secondary" />
        <h1 className="text-base font-medium text-dls-text">
          {t("connectors.title")}
        </h1>
      </header>

      {/* ============ ① 平台连接器 ============ */}
      <section className="mb-8" data-section="platform">
        <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-dls-secondary">
          {t("connectors.platform")}
        </h2>

        <div
          className="rounded-xl border border-dls-border bg-dls-surface p-4"
          data-feishu-connector
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-dls-text">
                {t("connectors.feishu_title")}
              </span>
              <span className="rounded-full bg-dls-hover px-2 py-0.5 text-[10px] text-dls-secondary">
                user-level
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <TextInput
              label={t("connectors.feishu_app_id")}
              placeholder="cli_xxx"
              value={feishuCreds.appId}
              onChange={(event) =>
                persistCreds({ ...feishuCreds, appId: event.currentTarget.value })
              }
            />
            <div>
              <div className="mb-1 text-xs font-medium text-dls-secondary">
                {t("connectors.feishu_app_secret")}
              </div>
              <div className="relative">
                <input
                  className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 pr-9 text-sm text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                  type={secretVisible ? "text" : "password"}
                  placeholder="••••••"
                  value={feishuCreds.appSecret}
                  onChange={(event) =>
                    persistCreds({
                      ...feishuCreds,
                      appSecret: event.currentTarget.value,
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={secretVisible ? "Hide" : "Show"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-dls-secondary hover:text-dls-text"
                  onClick={() => setSecretVisible((current) => !current)}
                >
                  {secretVisible ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {feishuInstalled ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void probe(FEISHU_MCP_NAME)}
              >
                <Zap className="size-3.5" data-icon="inline-start" />
                {t("connectors.test")}
              </Button>
              {/* 状态徽标：仅展示单一当前状态，避免多状态堆叠 */}
              <TestResultLine name={FEISHU_MCP_NAME} state={testState[FEISHU_MCP_NAME]} compact />
            </div>
          ) : (
            <>
              <div className="mt-3 rounded-md border border-dls-border bg-dls-hover p-3">
                <div className="mb-1 text-xs font-medium text-dls-text">
                  {t("connectors.feishu_step1")}
                </div>
                <p className="mb-2 text-xs text-dls-secondary">
                  {t("connectors.feishu_step1_desc")}
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-dls-border bg-dls-surface px-2 py-1 font-mono text-[11px]">
                    {buildFeishuLoginCommand(feishuCreds).join(" ")}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void copyToClipboard(buildFeishuLoginCommand(feishuCreds).join(" "))}
                  >
                    {t("connectors.copy")}
                  </Button>
                </div>
              </div>
              <div className="mt-2 rounded-md border border-dls-border bg-dls-hover p-3">
                <div className="mb-1 text-xs font-medium text-dls-text">
                  {t("connectors.feishu_step2")}
                </div>
                <p className="mb-2 text-xs text-dls-secondary">
                  {t("connectors.feishu_step2_desc")}
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-dls-border bg-dls-surface px-2 py-1 font-mono text-[11px]">
                    {buildFeishuCommand(feishuCreds).join(" ")}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void copyToClipboard(buildFeishuCommand(feishuCreds).join(" "))}
                  >
                    {t("connectors.copy")}
                  </Button>
                </div>
                <div className="mt-2 text-[11px] text-dls-secondary/70">
                  {t("connectors.feishu_step2_hint")}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={
                    feishuBusy || !feishuCreds.appId.trim() || !feishuCreds.appSecret.trim()
                  }
                  onClick={() => void connectFeishu()}
                >
                  {feishuBusy ? (
                    <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                  ) : (
                    <Plug className="size-3.5" data-icon="inline-start" />
                  )}
                  {feishuBusy
                    ? t("connectors.connecting")
                    : t("connectors.feishu_register")}
                </Button>
                {feishuStatus ? (
                  <span className="text-xs text-dls-secondary">{feishuStatus}</span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </section>

      {/* ============ ② 我的 MCP ============ */}
      <section data-section="custom">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-dls-secondary">
              {t("connectors.my_mcp")}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddMcpOpen(true)}
          >
            <Plus className="size-3.5" data-icon="inline-start" />
            {t("connectors.add")}
          </Button>
        </div>

        {props.mcpServers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
            <Plug className="mx-auto mb-3 size-6 text-dls-secondary/30" />
            <div className="text-sm text-dls-secondary">
              {t("connectors.no_mcp")}
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {props.mcpServers.map((entry) => {
              const enabled = entry.config.enabled !== false;
              const status =
                (props.mcpStatuses[entry.name]?.status as ReactMcpStatus) ??
                "disconnected";
              const showToggle = Boolean(props.setMcpEnabled);
              return (
                <li
                  key={entry.name}
                  className="flex items-center justify-between rounded-xl border border-dls-border bg-dls-surface p-3 transition-colors hover:bg-dls-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-dls-text">
                        {entry.name}
                      </span>
                      <span className="rounded-full bg-dls-hover px-2 py-0.5 text-[10px] text-dls-secondary">
                        {transportBadge(entry)}
                      </span>
                      <span
                        className={`size-2 rounded-full ${statusDot(status)}`}
                      />
                      <span className="text-[11px] text-dls-secondary">
                        {friendlyStatus(status)}
                      </span>
                    </div>
                    <TestResultLine
                      name={entry.name}
                      state={testState[entry.name]}
                      compact
                    />
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => probe(entry.name)}
                    >
                      {t("connectors.test")}
                    </Button>
                    {showToggle ? (
                      <Switch
                        checked={enabled}
                        disabled={togglingMcp === entry.name}
                        onCheckedChange={(checked: boolean) =>
                          toggleEnabled(entry.name, checked)
                        }
                        aria-label={enabled ? "Disable" : "Enable"}
                      />
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => props.removeMcp(entry.name)}
                    >
                      <Trash2 className="size-3" data-icon="inline-start" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AddMcpModal
        open={addMcpOpen}
        onClose={() => setAddMcpOpen(false)}
        onAdd={props.connectMcp}
        busy={props.busy ?? false}
      />
    </div>
  );
}

export default ConnectorsPage;

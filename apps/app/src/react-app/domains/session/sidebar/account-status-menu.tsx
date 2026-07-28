/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  LogOut,
  MessageCircleMore,
  MoreHorizontal,
  Settings,
  Sparkles,
  Stethoscope,
  UserRound,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import {
  buildDenAuthUrl,
  clearDenSession,
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../../app/lib/den";
import {
  openWorkConnectAttentionTitle,
  resolveOpenWorkConnectStatus,
  type OpenWorkConnectStatus,
} from "../../connections/openwork-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../../connections/use-session-mcp-maintenance";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  openWorkModelsPromoChangedEvent,
  useOpenWorkModelsPromoEligibility,
} from "../../cloud/openwork-models-promo";

const DOCS_URL = "https://openworklabs.com/docs";
const BOOT_STARTED_AT = Date.now();
const INITIALIZING_MS = 15_000;

type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

function StatusDot({ variant }: { variant: StatusDotVariant }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center">
      {variant === "loading" ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-9/35" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          variant === "connected" && "bg-green-9",
          variant === "loading" && "bg-amber-9",
          variant === "partial" && "bg-amber-9",
          variant === "disconnected" && "bg-red-9",
        )}
      />
    </span>
  );
}

type RuntimeStatus = {
  variant: StatusDotVariant;
  label: string;
  detail: string | null;
};

type RuntimeStatusInput = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  loading?: boolean;
  initializing: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
};

function resolveRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  if (input.reloadBusy) {
    return {
      variant: "loading",
      label: t("status.reloading_config"),
      detail: t("config.reload_now_desc"),
    };
  }
  if (input.reloadError) {
    return { variant: "disconnected", label: t("system.reload_failed"), detail: input.reloadError };
  }
  if (input.loading || (input.openworkServerStatus === "disconnected" && input.initializing)) {
    return {
      variant: "loading",
      label: t("session.preparing_workspace"),
      detail: t("session.loading_detail"),
    };
  }
  if (input.clientConnected) {
    return { variant: "connected", label: t("status.ready_for_tasks"), detail: null };
  }
  if (input.openworkServerStatus === "limited") {
    return { variant: "partial", label: t("status.limited_mode"), detail: t("status.limited_hint") };
  }
  return {
    variant: "disconnected",
    label: t("status.disconnected_label"),
    detail: t("status.disconnected_hint"),
  };
}

function connectDotVariant(status: OpenWorkConnectStatus): StatusDotVariant {
  if (status.state === "ready") return "connected";
  if (status.state === "checking") return "loading";
  return "disconnected";
}

function accountInitials(name: string | null, email: string) {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function useOpenWorkModelsPromoVisible(hasOpenWorkModels: boolean) {
  const { config } = useShellConfig();
  const eligible = useOpenWorkModelsPromoEligibility();
  const [hidden, setHidden] = useState(isOpenWorkModelsPromoHidden);

  useEffect(() => {
    const sync = () => setHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, sync);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, sync);
  }, []);

  return eligible && config.cloudSignin && !hasOpenWorkModels && !hidden;
}

export type AccountStatusMenuProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  /** Hidden until a workspace is selected, matching the old status bar. */
  showConnectionStatus: boolean;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  loading?: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
  openWorkConnectState?: SessionCloudMcpMaintenanceState;
  showSettingsButton?: boolean;
  onOpenAccountSettings?: () => void;
  onSendFeedback?: () => void;
};

/**
 * Sidebar footer control: the signed-in account plus the live status the app
 * used to show in a full-width bottom status bar.
 */
export function AccountStatusMenu(props: AccountStatusMenuProps) {
  const denAuth = useDenAuth();
  const platform = usePlatform();
  const navigate = useNavigate();
  const { config: shellConfig } = useShellConfig();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [initializing, setInitializing] = useState(
    () => Date.now() - BOOT_STARTED_AT < INITIALIZING_MS,
  );

  const hasOpenWorkModels = useMemo(
    () => hasOpenWorkModelsProvider(props.providerConnectedIds),
    [props.providerConnectedIds],
  );
  const promoVisible = useOpenWorkModelsPromoVisible(hasOpenWorkModels);

  useEffect(() => {
    if (!initializing) return;
    const remaining = Math.max(0, INITIALIZING_MS - (Date.now() - BOOT_STARTED_AT));
    const timeout = window.setTimeout(() => setInitializing(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [initializing]);

  const openSettings = props.onOpenAccountSettings;
  const openDocs = useCallback(() => platform.openLink(DOCS_URL), [platform]);

  const docsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.docs.open",
    label: "Open OpenWork docs",
    description: "Open the documentation from the account menu.",
    sideEffect: "external",
    targetRef: triggerRef,
    execute: openDocs,
  }), [openDocs]);
  useControlAction(docsControlAction);

  const feedbackControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.feedback.open",
    label: "Send feedback",
    description: "Open the OpenWork feedback surface from the account menu.",
    sideEffect: "external",
    disabled: !props.onSendFeedback,
    targetRef: triggerRef,
    execute: () => props.onSendFeedback?.(),
  }), [props.onSendFeedback]);
  useControlAction(feedbackControlAction);

  const settingsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.settings.open",
    label: "Open settings from the account menu",
    description: "Use the account menu in the sidebar footer.",
    sideEffect: "navigation",
    disabled: props.showSettingsButton === false || !openSettings,
    targetRef: triggerRef,
    execute: () => openSettings?.(),
  }), [openSettings, props.showSettingsButton]);
  useControlAction(settingsControlAction);

  const user = denAuth.user;
  const signedIn = denAuth.isSignedIn && user !== null;
  // A retained session still restores in the background; never flash "Sign in".
  const restoringSession = denAuth.status === "checking";
  const accountLabel = signedIn
    ? user.name?.trim() || user.email
    : restoringSession ? "OpenWork Cloud" : "Sign in";
  const accountDetail = signedIn
    ? (user.name ? user.email : "OpenWork Cloud")
    : restoringSession ? "Restoring your session" : "Sync with OpenWork Cloud";

  const runtimeStatus = props.showConnectionStatus
    ? resolveRuntimeStatus({
      clientConnected: props.clientConnected,
      openworkServerStatus: props.openworkServerStatus,
      loading: props.loading,
      initializing,
      reloadBusy: props.reloadBusy,
      reloadError: props.reloadError,
    })
    : null;
  const connectStatus = resolveOpenWorkConnectStatus(
    denAuth.isSignedIn
      || (denAuth.status === "checking" && Boolean(readDenSettings().authToken?.trim())),
    props.openWorkConnectState,
  );
  const connectNeedsAttention = connectStatus?.state === "needs_attention";
  const showStatus = shellConfig.statusBar && (runtimeStatus !== null || connectStatus !== null);

  const openSignIn = () => {
    platform.openLink(buildDenAuthUrl(readDenBootstrapConfig().baseUrl, "sign-up"));
  };

  const logOut = () => {
    const settings = readDenSettings();
    if (settings.authToken) {
      void createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken })
        .signOut()
        .catch(() => undefined);
    }
    clearDenSession();
    void denAuth.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-testid="account-status-menu"
            data-runtime-state={runtimeStatus?.variant}
            data-connect-state={connectStatus?.state}
            /* ps-1.5 puts the 24px avatar 12px from the edge, so the name lands on the sidebar label lane. */
            className="flex w-full items-center gap-2 rounded-lg ps-1.5 pe-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
            aria-label={signedIn ? `${user.email} — account and status` : "Account and status"}
            title={connectNeedsAttention
              ? openWorkConnectAttentionTitle(connectStatus.description)
              : connectStatus
                ? `${runtimeStatus ? `${runtimeStatus.label} · ` : ""}OpenWork Connect: ${connectStatus.label}`
                : runtimeStatus?.label}
          >
              {signedIn ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {accountInitials(user.name, user.email)}
                </span>
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
                  <UserRound size={13} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-sidebar-foreground">
                  {accountLabel}
                </span>
                <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">
                  {accountDetail}
                </span>
              </span>
              {connectNeedsAttention ? (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <StatusDot variant="disconnected" />
                </span>
              ) : null}
              <MoreHorizontal size={14} className="shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent side="top" align="start" className="w-72">
        {signedIn ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{user.email}</div>
        ) : null}

        {showStatus ? (
          <div className="mx-1 mb-1 flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
            {runtimeStatus ? (
              <div className="flex items-start gap-2">
                <span className="mt-1">
                  <StatusDot variant={runtimeStatus.variant} />
                </span>
                <div className="min-w-0">
                  <div className="text-[11.5px] font-medium text-foreground">{runtimeStatus.label}</div>
                  {runtimeStatus.detail ? (
                    <div className="text-[10.5px] leading-tight text-muted-foreground">
                      {runtimeStatus.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {connectStatus ? (
              <div data-testid="openwork-connect-status" className="flex items-start gap-2">
                <span className="mt-1">
                  <StatusDot variant={connectDotVariant(connectStatus)} />
                </span>
                <div className="min-w-0">
                  <div className="text-[11.5px] font-medium text-foreground">
                    {`OpenWork Connect: ${connectStatus.label}`}
                  </div>
                  <div className="text-[10.5px] leading-tight text-muted-foreground">
                    {connectStatus.description}
                  </div>
                </div>
              </div>
            ) : null}
            {props.showConnectionStatus ? (
              <div className="text-[10.5px] leading-tight text-muted-foreground">
                {t("account.providers_connected", { count: props.providerConnectedIds.length })}
                {" · "}
                {t("account.mcp_connected", { count: props.mcpConnectedCount })}
                {props.developerMode ? ` · ${t("status.developer_mode")}` : ""}
              </div>
            ) : null}
          </div>
        ) : null}

        {connectNeedsAttention ? (
          <DropdownMenuItem onClick={() => navigate("/settings/debug")}>
            <Stethoscope className="size-3.5" />
            Run diagnostics
          </DropdownMenuItem>
        ) : null}
        {promoVisible ? (
          <DropdownMenuItem
            onClick={() => {
              hideOpenWorkModelsPromo();
              if (!denAuth.isSignedIn) navigate("/settings/cloud-account");
              platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
            }}
          >
            <Sparkles className="size-3.5 text-blue-11" />
            <span className="flex min-w-0 flex-col">
              <span>OpenWork Models</span>
              <span className="text-[10.5px] text-muted-foreground">hosted frontier models</span>
            </span>
          </DropdownMenuItem>
        ) : null}
        {connectNeedsAttention || promoVisible ? <DropdownMenuSeparator /> : null}

        {props.showSettingsButton !== false ? (
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            {t("status.settings")}
          </DropdownMenuItem>
        ) : null}
        {shellConfig.docsButton ? (
          <DropdownMenuItem onClick={openDocs}>
            <BookOpen className="size-3.5" />
            {t("status.docs")}
          </DropdownMenuItem>
        ) : null}
        {shellConfig.feedbackButton && props.onSendFeedback ? (
          <DropdownMenuItem onClick={props.onSendFeedback}>
            <MessageCircleMore className="size-3.5" />
            {t("status.feedback")}
          </DropdownMenuItem>
        ) : null}
        {signedIn ? (
          <DropdownMenuItem onClick={logOut}>
            <LogOut className="size-3.5" />
            Log out
          </DropdownMenuItem>
        ) : restoringSession ? null : (
          <DropdownMenuItem onClick={openSignIn}>
            <UserRound className="size-3.5" />
            Sign in
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

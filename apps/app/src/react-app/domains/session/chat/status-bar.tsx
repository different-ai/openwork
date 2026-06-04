/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, Cloud, MessageCircleMore, Settings, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { buildDenAuthUrl, readDenBootstrapConfig } from "@/app/lib/den";
import { usePlatform } from "../../../kernel/platform";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  markOpenWorkModelsPromoShown,
  OPENWORK_MODELS_PROMO_SHOW_DELAY_MS,
  OPENWORK_MODELS_PROMO_VISIBLE_MS,
  openWorkModelsPromoChangedEvent,
  shouldShowOpenWorkModelsPromo,
} from "../../cloud/openwork-models-promo";

const DOCS_URL = "https://openworklabs.com/docs";
const STATUS_BAR_BOOT_STARTED_AT = Date.now();
const STATUS_BAR_INITIALIZING_MS = 15_000;

type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

type StatusDotProps = {
  variant: StatusDotVariant;
};

function StatusDot({ variant }: StatusDotProps) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
      {variant === "loading" ? (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full bg-amber-9/35"
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          variant === "connected" && "bg-green-9",
          variant === "loading" && "bg-amber-9",
          variant === "partial" && "bg-amber-9",
          variant === "disconnected" && "bg-red-9",
        )}
      />
    </span>
  );
}

type StatusIndicatorProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  mcpConnectedCount: number;
  loading?: boolean;
  initializing: boolean;
};

function StatusIndicator(props: StatusIndicatorProps) {
  if (props.loading || (props.openworkServerStatus === "disconnected" && props.initializing)) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="loading" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("session.preparing_workspace")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {t("session.loading_detail")}
        </span>
      </div>
    );
  }

  if (props.clientConnected) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <StatusDot variant="connected" />
          </TooltipTrigger>
          <TooltipContent>{t("status.connected")}</TooltipContent>
        </Tooltip>
        <span className="truncate text-muted-foreground text-xs">
          {props.mcpConnectedCount > 0
            ? t("status.mcp_connected", undefined, { count: props.mcpConnectedCount })
            : t("status.ready_for_tasks")}
        </span>
        {props.developerMode ? (
          <span className="truncate text-muted-foreground text-xs">
            {t("status.developer_mode")}
          </span>
        ) : null}
      </div>
    );
  }

  if (props.openworkServerStatus === "limited") {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot variant="partial" />
        <span className="shrink-0 font-medium text-foreground text-xs">
          {t("status.limited_mode")}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {props.mcpConnectedCount > 0
            ? t("status.limited_mcp_hint", undefined, { count: props.mcpConnectedCount })
            : t("status.limited_hint")}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <StatusDot variant="disconnected" />
      <span className="shrink-0 font-medium text-foreground text-xs">
        {t("status.disconnected_label")}
      </span>
      <span className="truncate text-muted-foreground text-xs">
        {t("status.disconnected_hint")}
      </span>
    </div>
  );
}

export type StatusBarProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  settingsOpen: boolean;
  onSendFeedback: () => void;
  onOpenSettings: () => void;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  loading?: boolean;
  showSettingsButton?: boolean;
  initializing?: boolean;
};

export function StatusBar(props: StatusBarProps) {
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const { config: shellConfig } = useShellConfig();
  const docsButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [openWorkModelsHintVisible, setOpenWorkModelsHintVisible] = useState(false);
  const hasOpenWorkModels = useMemo(
    () => hasOpenWorkModelsProvider(props.providerConnectedIds),
    [props.providerConnectedIds],
  );
  const [initializing, setInitializing] = useState(
    () => Date.now() - STATUS_BAR_BOOT_STARTED_AT < STATUS_BAR_INITIALIZING_MS,
  );

  useEffect(() => {
    if (!initializing) return;
    const remaining = Math.max(
      0,
      STATUS_BAR_INITIALIZING_MS - (Date.now() - STATUS_BAR_BOOT_STARTED_AT),
    );
    const timeout = window.setTimeout(() => setInitializing(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [initializing]);

  useEffect(() => {
    const handlePromoChanged = () => {
      if (isOpenWorkModelsPromoHidden()) {
        setOpenWorkModelsHintVisible(false);
      }
    };
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  useEffect(() => {
    if (!shellConfig.cloudSignin || hasOpenWorkModels) {
      setOpenWorkModelsHintVisible(false);
      return;
    }
    if (denAuth.status === "checking") return;

    let showTimeout: number | null = null;
    const maybeShow = () => {
      if (showTimeout !== null || !shouldShowOpenWorkModelsPromo()) return;
      showTimeout = window.setTimeout(() => {
        showTimeout = null;
        if (!shouldShowOpenWorkModelsPromo()) return;
        markOpenWorkModelsPromoShown();
        setOpenWorkModelsHintVisible(true);
      }, OPENWORK_MODELS_PROMO_SHOW_DELAY_MS);
    };

    maybeShow();
    const interval = window.setInterval(maybeShow, 60_000);
    return () => {
      if (showTimeout !== null) {
        window.clearTimeout(showTimeout);
      }
      window.clearInterval(interval);
    };
  }, [denAuth.status, hasOpenWorkModels, shellConfig.cloudSignin]);

  useEffect(() => {
    if (!openWorkModelsHintVisible) return;
    const timeout = window.setTimeout(
      () => setOpenWorkModelsHintVisible(false),
      OPENWORK_MODELS_PROMO_VISIBLE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [openWorkModelsHintVisible]);

  const openOpenWorkModels = useCallback(() => {
    setOpenWorkModelsHintVisible(false);
    if (!denAuth.isSignedIn) {
      navigate("/settings/cloud-account");
    }
    platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
  }, [denAuth.isSignedIn, navigate, platform]);

  const hideOpenWorkModels = useCallback(() => {
    setOpenWorkModelsHintVisible(false);
    hideOpenWorkModelsPromo();
  }, []);

  const docsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.docs.open",
    label: "Open OpenWork docs",
    description: "Open the documentation from the status bar.",
    sideEffect: "external",
    targetRef: docsButtonRef,
    execute: () => platform.openLink(DOCS_URL),
  }), [platform]);
  useControlAction(docsControlAction);

  const feedbackControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.feedback.open",
    label: "Send feedback",
    description: "Open the OpenWork feedback surface from the status bar.",
    sideEffect: "external",
    targetRef: feedbackButtonRef,
    execute: props.onSendFeedback,
  }), [props.onSendFeedback]);
  useControlAction(feedbackControlAction);

  const settingsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.settings.open",
    label: props.settingsOpen ? "Go back from settings" : "Open settings from the status bar",
    description: "Use the visible settings button in the status bar.",
    sideEffect: "navigation",
    disabled: props.showSettingsButton === false,
    targetRef: settingsButtonRef,
    execute: props.onOpenSettings,
  }), [props.onOpenSettings, props.settingsOpen, props.showSettingsButton]);
  useControlAction(settingsControlAction);

  return (
    <div className="border-t border-border bg-background">
      <div className="flex h-8 items-center justify-between gap-3 px-4 md:px-6">
        <StatusIndicator
          clientConnected={props.clientConnected}
          openworkServerStatus={props.openworkServerStatus}
          developerMode={props.developerMode}
          mcpConnectedCount={props.mcpConnectedCount}
          loading={props.loading}
          initializing={initializing}
        />

        <div className="flex items-center gap-1">
          {openWorkModelsHintVisible ? (
            <div className="mr-1 flex h-6 items-center overflow-hidden rounded-full border border-blue-6/60 bg-blue-2/70 shadow-[0_0_18px_rgba(var(--dls-accent-rgb),0.16)] animate-in fade-in slide-in-from-bottom-1 zoom-in-95 duration-300">
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 px-2.5 text-xs font-medium text-blue-12 transition-colors hover:bg-blue-3/70"
                onClick={openOpenWorkModels}
              >
                <Sparkles className="size-3.5 text-blue-11" />
                <span className="whitespace-nowrap">OpenWork Models</span>
                <span className="hidden whitespace-nowrap font-normal text-blue-11/75 lg:inline">
                  hosted frontier models
                </span>
                <ArrowRight className="size-3.5 text-blue-11" />
              </button>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center border-l border-blue-6/60 text-blue-11 transition-colors hover:bg-blue-3/70"
                onClick={hideOpenWorkModels}
                aria-label="Hide OpenWork Models hint"
              >
                <X className="size-3" />
              </button>
            </div>
          ) : null}
          {shellConfig.cloudSignin && !denAuth.isSignedIn && denAuth.status !== "checking" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => {
                      const baseUrl = readDenBootstrapConfig().baseUrl;
                      platform.openLink(buildDenAuthUrl(baseUrl, "sign-in"));
                    }}
                    aria-label={t("den.signin_title")}
                  >
                    <Cloud className="size-3.5" />
                    <span>{t("den.signin_button")}</span>
                  </Button>
                )}
              />
              <TooltipContent>{t("den.signin_title")}</TooltipContent>
            </Tooltip>
          ) : null}
          {shellConfig.docsButton ? (
            <Button
              ref={docsButtonRef}
              className="text-muted-foreground gap-2"
              variant="ghost"
              size="xs"
              onClick={() => platform.openLink(DOCS_URL)}
              title={t("status.open_docs")}
              aria-label={t("status.open_docs")}
            >
              <BookOpen className="size-3.5" />
              <span>{t("status.docs")}</span>
            </Button>
          ) : null}
          {shellConfig.feedbackButton ? (
            <Button
              ref={feedbackButtonRef}
              className="text-muted-foreground gap-2"
              variant="ghost"
              size="xs"
              onClick={props.onSendFeedback}
              title={t("status.send_feedback")}
              aria-label={t("status.send_feedback")}
            >
              <MessageCircleMore className="size-3.5" />
              <span>
                {t("status.feedback")}
              </span>
            </Button>
          ) : null}
          {props.showSettingsButton !== false ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    ref={settingsButtonRef}
                    className="text-muted-foreground gap-2"
                    variant="ghost"
                    size="icon-xs"
                    onClick={props.onOpenSettings}
                    aria-label={props.settingsOpen ? t("status.back") : t("status.settings")}
                  >
                    <Settings className="size-3.5" />
                  </Button>
                )}
              />
              <TooltipContent>{t("status.settings")}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

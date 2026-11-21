/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import {
  deepLinkBridgeEvent,
  takePendingDeepLinks,
  type DeepLinkBridgeDetail,
} from "../../app/lib/deep-link-bridge";
import { parseChatDeepLink } from "../../app/lib/openwork-links";
import { isDesktopRuntime } from "../../app/utils";
import { setPendingChatSeed } from "../domains/session/chat/pending-chat-seed";
import { seededConnectorDraft } from "../domains/session/surface/composer/connector-token";
import { readActiveWorkspaceId } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

const isChatDeepLink = (url: string) => parseChatDeepLink(url) !== null;

export function ChatDeepLinkListener() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (typeof window === "undefined" || !isDesktopRuntime()) return;

    const handleUrls = (urls: readonly string[]) => {
      const link = urls.map(parseChatDeepLink).findLast((parsed) => parsed !== null) ?? null;
      if (!link) return;
      setPendingChatSeed(seededConnectorDraft(link));
      const workspaceId = readActiveWorkspaceId();
      navigateRef.current(workspaceId ? workspaceSessionRoute(workspaceId) : "/session");
    };

    handleUrls(takePendingDeepLinks(window, isChatDeepLink));
    const handleDeepLink = (event: Event) => {
      const detail = (event as CustomEvent<DeepLinkBridgeDetail>).detail;
      handleUrls(Array.isArray(detail?.urls) ? detail.urls : []);
      takePendingDeepLinks(window, isChatDeepLink);
    };
    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, []);

  return null;
}

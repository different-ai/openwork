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

/**
 * `openwork://chat?connector=…&prompt=…` from Den's connector catalog: land on
 * the active workspace's new-task state with the connector chip and starter
 * prompt already in the composer. Nothing is sent until the person presses
 * send. Sibling of the connect and den-auth deep-link consumers; it only
 * takes chat links out of the shared queue, and the same link may be opened
 * again later to seed another chat.
 */
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
      // The bridge queues the same links it announces; clear ours so a later
      // effect run does not replay them.
      takePendingDeepLinks(window, isChatDeepLink);
    };
    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, []);

  return null;
}

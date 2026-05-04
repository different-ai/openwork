/** @jsxImportSource react */
import { useMemo } from "react";

import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { readRealtimeControlMicPreference } from "../../../domains/settings/state/realtime-control-preferences";
import { useControlAction, type OpenworkControlAction } from "../../control/control-provider";
import { getRealtimeControlController } from "./openai-realtime-controller";

export function useOpenAIRealtimeControlActions(input: {
  enabled: boolean;
  client: OpenworkServerClient | null;
}) {
  const remoteRealtimeConnectAction = useMemo<OpenworkControlAction>(() => ({
    id: "remote.realtime.connect",
    label: "Connect OpenAI Realtime microphone control",
    description: "Start a browser Realtime session that listens to the microphone and can call OpenWork control actions.",
    sideEffect: "external",
    disabled: !input.enabled || !input.client,
    execute: async () => {
      if (!input.enabled) return { status: "error", lastError: "Realtime control is disabled in Feature Preview settings" };
      if (!input.client) return { status: "error", lastError: "OpenWork server is not connected" };
      const mic = readRealtimeControlMicPreference();
      return getRealtimeControlController().connect({
        createSession: () => input.client!.createRemoteSession(),
        audioInput: true,
        audioDeviceId: mic.deviceId,
        audioDeviceLabel: mic.label,
      });
    },
  }), [input]);
  useControlAction(remoteRealtimeConnectAction);

  const remoteRealtimeTextAction = useMemo<OpenworkControlAction>(() => ({
    id: "remote.realtime.send_text",
    label: "Send text to OpenAI Realtime remote control",
    description: "Send a text message through the connected Realtime session.",
    sideEffect: "external",
    requiresArgs: true,
    disabled: !input.enabled,
    previewArgs: { text: "List the available OpenWork actions." },
    execute: (_args) => {
      const text = typeof _args === "object" && _args && "text" in _args && typeof (_args as { text?: unknown }).text === "string"
        ? (_args as { text: string }).text
        : "List the available OpenWork actions.";
      getRealtimeControlController().sendText(text);
      return getRealtimeControlController().state();
    },
  }), [input]);
  useControlAction(remoteRealtimeTextAction);

  const remoteRealtimeDisconnectAction = useMemo<OpenworkControlAction>(() => ({
    id: "remote.realtime.disconnect",
    label: "Disconnect OpenAI Realtime remote control",
    description: "Close the browser Realtime session.",
    sideEffect: "external",
    disabled: !input.enabled,
    execute: () => {
      getRealtimeControlController().disconnect();
      return getRealtimeControlController().state();
    },
  }), [input]);
  useControlAction(remoteRealtimeDisconnectAction);
}

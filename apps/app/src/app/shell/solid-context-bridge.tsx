import type { ParentProps } from "solid-js";

import { PlatformProvider, type Platform } from "../context/platform";
import { LocalValueProvider, type LocalContextValue } from "../context/local";
import type { GlobalSDKContextValue } from "../context/global-sdk";
import { GlobalSDKValueProvider } from "../context/global-sdk";
import type { GlobalSyncContextValue } from "../context/global-sync";
import { GlobalSyncValueProvider } from "../context/global-sync";
import type { ServerContextValue } from "../context/server";
import { ServerValueProvider } from "../context/server";

type SolidContextBridgeProps = ParentProps<{
  platform: Platform;
  server: ServerContextValue;
  globalSDK: GlobalSDKContextValue;
  globalSync: GlobalSyncContextValue;
  local: LocalContextValue;
}>;

export default function SolidContextBridge(props: SolidContextBridgeProps) {
  return (
    <PlatformProvider value={props.platform}>
      <ServerValueProvider value={props.server}>
        <GlobalSDKValueProvider value={props.globalSDK}>
          <GlobalSyncValueProvider value={props.globalSync}>
            <LocalValueProvider value={props.local}>
              {props.children}
            </LocalValueProvider>
          </GlobalSyncValueProvider>
        </GlobalSDKValueProvider>
      </ServerValueProvider>
    </PlatformProvider>
  );
}

import { isMicxGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isMicxGatewayRuntime();
}

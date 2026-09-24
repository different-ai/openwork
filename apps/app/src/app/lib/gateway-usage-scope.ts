import { readDenSettings } from "./den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "./den-session-events";

let generation = 0;
let current: ReturnType<typeof capture> | undefined;
function capture() {
  const settings = readDenSettings();
  return { baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token: settings.authToken, organizationId: settings.activeOrgId, generation: ++generation };
}

export function readGatewayUsageScope() {
  const next = readDenSettings();
  if (!current || current.baseUrl !== next.baseUrl || current.apiBaseUrl !== next.apiBaseUrl || current.token !== next.authToken || current.organizationId !== next.activeOrgId) {
    current = capture();
  }
  return current;
}

export function subscribeGatewayUsageScope(listener: () => void) {
  window.addEventListener(denSettingsChangedEvent, listener);
  window.addEventListener(denSessionUpdatedEvent, listener);
  return () => {
    window.removeEventListener(denSettingsChangedEvent, listener);
    window.removeEventListener(denSessionUpdatedEvent, listener);
  };
}

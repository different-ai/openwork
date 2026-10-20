import { describe, expect, test } from "bun:test";
import {
  pickerFallbackModels,
  shouldRefreshProvidersForReloadEvent,
  skipsLegacyProviderRefresh,
  usesLiveProviderSync,
} from "../src/react-app/domains/connections/provider-auth/live-provider-sync";

const v1 = "http://localhost:4096";
const v2 = "http://localhost:8787/opencode2";

describe("live provider sync ownership", () => {
  for (const baseUrl of [v1, v2]) {
    for (const liveProviderSync of [false, true]) {
      test(`${baseUrl} server rollout ${liveProviderSync}`, () => {
        const live = usesLiveProviderSync({ baseUrl,
          status: { enabled: true, chatRouting: true, liveProviderSync } });
        expect(live).toBe(baseUrl === v2 && liveProviderSync);
        for (const reason of ["model_picker_open", "new_chat"]) {
          expect(skipsLegacyProviderRefresh(reason, live)).toBe(baseUrl === v2 && liveProviderSync);
        }
        expect(shouldRefreshProvidersForReloadEvent(live)).toBe(!(baseUrl === v2 && liveProviderSync));
        for (const reason of ["app_launch", "sign_in", "app_resume", "manual"]) {
          expect(skipsLegacyProviderRefresh(reason, live)).toBe(false);
        }
      });
    }
  }

  test("disabled V2 routing cannot own live sync", () => {
    expect(usesLiveProviderSync({ baseUrl: v2,
      status: { enabled: true, chatRouting: false, liveProviderSync: true } })).toBe(false);
    expect(usesLiveProviderSync({ baseUrl: v2,
      status: { enabled: false, chatRouting: true, liveProviderSync: true } })).toBe(false);
  });

  test("missing effective server ownership defaults off, never trusts an old server", () => {
    expect(usesLiveProviderSync({ baseUrl: v2 })).toBe(false);
    expect(usesLiveProviderSync({ baseUrl: v2,
      status: { enabled: true, chatRouting: true } })).toBe(false);
  });
});

describe("picker fallback models", () => {
  const assigned = [{ providerID: "ipr_org", modelID: "gwm_turned_off" }];
  test("live sync drops the app's own Den list once the engine has answered", () => {
    expect(pickerFallbackModels({ liveProviderSync: true, engineListLoaded: true, assigned })).toEqual([]);
  });
  test("it still fills the picker until the engine answers, and always without live sync", () => {
    expect(pickerFallbackModels({ liveProviderSync: true, engineListLoaded: false, assigned })).toEqual(assigned);
    expect(pickerFallbackModels({ liveProviderSync: false, engineListLoaded: true, assigned })).toEqual(assigned);
  });
});

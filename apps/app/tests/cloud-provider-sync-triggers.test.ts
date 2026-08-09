import { describe, expect, test } from "bun:test";

import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { subscribeCloudProviderSyncTriggers } from "../src/react-app/domains/cloud/use-cloud-provider-auto-sync";

describe("cloud provider sync triggers", () => {
  test("reconciles on settings, focus, online, visible, and coarse interval transitions", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const reasons: string[] = [];
    let visible = false;
    const unsubscribe = subscribeCloudProviderSyncTriggers({
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      sync: (reason) => reasons.push(reason),
      intervalMs: 10,
    });

    windowTarget.dispatchEvent(new Event(denSettingsChangedEvent));
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("online"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visible = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(reasons).toEqual(["sign_in", "app_resume", "app_resume", "app_resume"]);

    await Bun.sleep(25);
    expect(reasons.length).toBeGreaterThan(4);
    expect(reasons.at(-1)).toBe("app_resume");

    unsubscribe();
    const reasonCount = reasons.length;
    windowTarget.dispatchEvent(new Event("focus"));
    await Bun.sleep(15);
    expect(reasons).toHaveLength(reasonCount);
  });
});

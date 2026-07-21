import { describe, expect, test } from "bun:test";

import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { subscribeCloudProviderSyncTriggers } from "../src/react-app/domains/cloud/use-cloud-provider-auto-sync";

describe("cloud provider sync triggers", () => {
  test("reconciles on settings, focus, online, and visible transitions", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const reasons: string[] = [];
    let visible = false;
    const unsubscribe = subscribeCloudProviderSyncTriggers({
      windowTarget,
      documentTarget,
      isDocumentVisible: () => visible,
      sync: (reason) => reasons.push(reason),
    });

    windowTarget.dispatchEvent(new Event(denSettingsChangedEvent));
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("online"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visible = true;
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(reasons).toEqual(["sign_in", "app_resume", "app_resume", "app_resume"]);

    unsubscribe();
    windowTarget.dispatchEvent(new Event("focus"));
    expect(reasons).toHaveLength(4);
  });
});

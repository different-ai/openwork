import { describe, expect, test } from "bun:test";

import { createCloudProviderSyncRunner } from "../src/react-app/domains/cloud/use-cloud-provider-auto-sync";
import type { CloudProviderSyncReason } from "../src/react-app/domains/cloud/use-cloud-provider-auto-sync";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createCloudProviderSyncRunner", () => {
  test("coalesces settings changes into one follow-up without overlap", async () => {
    const first = deferred();
    const reasons: CloudProviderSyncReason[] = [];
    let active = 0;
    let maxActive = 0;
    const runner = createCloudProviderSyncRunner(async (reason) => {
      reasons.push(reason);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (reasons.length === 1) await first.promise;
      active -= 1;
    });

    const idle = runner.request("interval");
    void runner.request("sign_in");
    void runner.request("settings_cloud_opened");
    expect(reasons).toEqual(["interval"]);

    first.resolve();
    await idle;

    expect(reasons).toEqual(["interval", "settings_cloud_opened"]);
    expect(maxActive).toBe(1);
  });

  test("cancels a pending follow-up", async () => {
    const first = deferred();
    const reasons: CloudProviderSyncReason[] = [];
    const runner = createCloudProviderSyncRunner(async (reason) => {
      reasons.push(reason);
      await first.promise;
    });

    const idle = runner.request("interval");
    void runner.request("sign_in");
    runner.cancel();
    first.resolve();
    await idle;

    expect(reasons).toEqual(["interval"]);
  });

  test("runs the latest pending state after a failure", async () => {
    const first = deferred();
    const reasons: CloudProviderSyncReason[] = [];
    const runner = createCloudProviderSyncRunner(async (reason) => {
      reasons.push(reason);
      if (reasons.length === 1) {
        await first.promise;
        throw new Error("network unavailable");
      }
    });

    const idle = runner.request("interval");
    void runner.request("sign_in");
    first.resolve();
    await idle;

    expect(reasons).toEqual(["interval", "sign_in"]);
  });
});

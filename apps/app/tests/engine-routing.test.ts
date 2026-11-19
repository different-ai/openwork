import { expect, test } from "bun:test";
import { startEngineRoutingPolling } from "../src/react-app/shell/use-engine-routing";
import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const status: EngineV2PreviewStatus = {
  enabled: false, running: false, chatRouting: false,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
};

test("host routing changes refresh the app without migration status or actions", async () => {
  let current = status;
  let next: (() => void) | undefined;
  let changed = 0;
  let cancelled = false;
  const stop = startEngineRoutingPolling({
    read: async () => ({ baseUrl: "http://localhost:8787/", status: current }),
    changed: () => { changed++; },
    schedule: (callback) => { next = callback; return () => { cancelled = true; }; },
  });
  await Promise.resolve();
  expect(changed).toBe(0);
  current = { ...status, enabled: true, running: true, chatRouting: true };
  next?.();
  await Promise.resolve();
  expect(changed).toBe(1);
  next?.();
  await Promise.resolve();
  expect(changed).toBe(1);
  stop();
  expect(cancelled).toBe(true);
  current = status;
  next?.();
  await Promise.resolve();
  expect(changed).toBe(1);
});

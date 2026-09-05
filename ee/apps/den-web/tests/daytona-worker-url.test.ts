import { expect, test } from "bun:test";
import {
  buildOpenworkAppConnectUrl,
  buildOpenworkDeepLink,
  getWorker,
  getWorkerConnectionTargets,
  getWorkerConnectionTokens,
  getWorkerConnectionRefreshDelay,
  getWorkerConnectionPollDelay,
  getWorkerSummary,
  getWorkerTokens,
  getWorkersList,
  withWorkerConnection,
  workerNeedsConnectionResolution,
  workerConnectionEquals,
} from "../app/(den)/_lib/den-flow";

const daytonaInstance = {
  provider: "daytona",
  status: "healthy",
  url: "https://expired.preview.example.test",
};

test("Den Web never treats Daytona list or detail URLs as durable connections", () => {
  const worker = { id: "worker-1", name: "Cloud", status: "healthy" };

  expect(getWorker({ worker, instance: daytonaInstance, tokens: {} })?.instanceUrl).toBeNull();
  expect(getWorker({ worker, instance: daytonaInstance, tokens: {} })?.openworkUrl).toBeNull();
  expect(getWorkerSummary({ worker, instance: daytonaInstance })?.instanceUrl).toBeNull();
  expect(getWorkersList({ workers: [{ ...worker, instance: daytonaInstance }] })[0]?.instanceUrl).toBeNull();
})

test("Den Web keeps durable URLs and separates stable connections from direct previews", () => {
  const worker = { id: "worker-1", name: "Remote", status: "healthy" };
  const renderInstance = { provider: "render", status: "healthy", url: "https://durable.render.example.test" };

  expect(getWorkerSummary({ worker, instance: renderInstance })?.instanceUrl).toBe("https://durable.render.example.test");
  const tokens = getWorkerTokens({
    tokens: { client: "client-token", host: "host-token" },
    connect: { openworkUrl: "https://den.example.test/v1/cloud/workers/worker-1/w/workspace", workspaceId: "workspace" },
    directPreview: {
      version: 1,
      openworkUrl: "https://fresh.preview.example.test/w/workspace",
      workspaceId: "workspace",
      expiresAt: "2026-08-27T12:00:00.000Z",
    },
  });
  expect(tokens?.openworkUrl).toBe("https://den.example.test/v1/cloud/workers/worker-1/w/workspace");
  expect(tokens?.previewOpenworkUrl).toBe("https://fresh.preview.example.test/w/workspace");
  expect(tokens?.previewExpiresAt).toBe("2026-08-27T12:00:00.000Z");
  const daytonaWorker = getWorker({ worker, instance: daytonaInstance, tokens: {} });
  if (!daytonaWorker || !tokens) throw new Error("worker connection payload did not parse");
  expect(getWorkerConnectionTargets({
    ...daytonaWorker,
    openworkUrl: tokens.openworkUrl,
    previewOpenworkUrl: tokens.previewOpenworkUrl,
  })).toEqual({
    desktopUrl: "https://den.example.test/v1/cloud/workers/worker-1/w/workspace",
    webUrl: "https://fresh.preview.example.test/w/workspace",
  });
  const connectedWorker = withWorkerConnection(daytonaWorker, tokens);
  const connectionTokens = getWorkerConnectionTokens(connectedWorker);
  expect(connectionTokens).toEqual({ desktopToken: "host-token", webToken: "client-token" });
  const desktopLink = buildOpenworkDeepLink(
    connectedWorker.openworkUrl,
    connectionTokens.desktopToken,
    connectedWorker.workerId,
    connectedWorker.workerName,
  );
  const webLink = buildOpenworkAppConnectUrl(
    "https://app.example.test/connect-remote",
    connectedWorker.previewOpenworkUrl ?? null,
    connectionTokens.webToken,
    connectedWorker.workerId,
    connectedWorker.workerName,
  );
  expect(new URL(desktopLink ?? "").searchParams.get("openworkToken")).toBe("host-token");
  expect(new URL(webLink ?? "").searchParams.get("openworkToken")).toBe("client-token");
})

test("create tokens without a URL keep polling until the late resolver URL is adopted", () => {
  const created = getWorker({
    worker: { id: "worker-late-url", name: "Cloud", status: "provisioning" },
    instance: null,
    tokens: { client: "client-token", owner: "host-token", host: "host-token" },
  });
  if (!created) throw new Error("create worker payload did not parse");

  expect(created.openworkUrl).toBeNull();
  expect(workerNeedsConnectionResolution(created)).toBe(true);

  const early = getWorkerTokens({
    tokens: { client: "client-token", owner: "host-token", host: "host-token" },
    connect: null,
  });
  if (!early) throw new Error("early token payload did not parse");
  const waiting = withWorkerConnection(created, early);
  expect(workerNeedsConnectionResolution(waiting)).toBe(true);

  const late = getWorkerTokens({
    tokens: { client: "client-token", owner: "host-token", host: "host-token" },
    connect: {
      openworkUrl: "https://den.example.test/v1/cloud/workers/worker-late-url/w/workspace",
      workspaceId: "workspace",
    },
    directPreview: {
      version: 1,
      openworkUrl: "https://late.preview.example.test/w/workspace",
      workspaceId: "workspace",
      expiresAt: "2026-08-27T12:00:00.000Z",
    },
  });
  if (!late) throw new Error("late token payload did not parse");
  const ready = withWorkerConnection(waiting, late);

  expect(ready.openworkUrl).toBe("https://den.example.test/v1/cloud/workers/worker-late-url/w/workspace");
  expect(ready.previewOpenworkUrl).toBe("https://late.preview.example.test/w/workspace");
  expect(ready.clientToken).toBe("client-token");
  expect(ready.hostToken).toBe("host-token");
  const now = new Date("2026-08-27T10:00:00.000Z").getTime();
  expect(workerNeedsConnectionResolution(ready, now)).toBe(false);
  expect(getWorkerConnectionRefreshDelay(ready, now)).toBe(119 * 60 * 1000 + 30 * 1000);
  expect(workerNeedsConnectionResolution(ready, new Date("2026-08-27T11:59:45.000Z").getTime())).toBe(true);
  const expiryOnlyRefresh = { ...ready, previewExpiresAt: "2026-08-27T14:00:00.000Z" };
  expect(workerConnectionEquals(ready, expiryOnlyRefresh)).toBe(false);
  const adopted = workerConnectionEquals(ready, expiryOnlyRefresh) ? ready : expiryOnlyRefresh;
  expect(adopted.previewExpiresAt).toBe("2026-08-27T14:00:00.000Z");
  expect(workerNeedsConnectionResolution({ ...waiting, status: "failed" })).toBe(false);
  expect([1, 2, 3, 30].map(getWorkerConnectionPollDelay)).toEqual([1_000, 2_000, 4_000, 4_000]);
})

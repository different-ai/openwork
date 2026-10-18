import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver, isCancelledError } from "@tanstack/react-query";
import { clearDeniedRoleReads, permissionsQueryKeys, PERMISSION_READ_STALE_TIME } from "./permissions-query-keys";

test("a denied role read stays masked across remount and network failure, without clearing another viewer", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const listA = permissionsQueryKeys.sets("org", "viewer_a");
  const roleA = permissionsQueryKeys.set("org", "role", "viewer_a");
  const roleB = permissionsQueryKeys.set("org", "role", "viewer_b");
  client.setQueryData(listA, ["private role name"]);
  client.setQueryData(roleA, ["private permissions"]);
  client.setQueryData(roleB, ["other viewer's authorized permissions"]);
  const pending: { resolve?: (value: string[]) => void } = {};
  const beforeDenial = new Promise<string[]>((resolve) => { pending.resolve = resolve; });
  const oldRead = client.fetchQuery({ queryKey: roleA, queryFn: () => beforeDenial });
  const oldResult = oldRead.catch((error: unknown) => error);

  await clearDeniedRoleReads(client, "org", "viewer_a");
  assert.equal(client.getQueryData(listA), null);
  assert.equal(client.getQueryData(roleA), null);
  assert.deepEqual(client.getQueryData(roleB), ["other viewer's authorized permissions"]);
  assert.ok(isCancelledError(await oldResult));
  assert.ok(pending.resolve);
  pending.resolve(["late pre-denial response"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.getQueryData(roleA), null, "an older in-flight response cannot restore protected data");

  await assert.rejects(client.fetchQuery({ queryKey: roleA, queryFn: async () => { throw new Error("network unavailable"); } }), /network unavailable/);
  const remounted = new QueryObserver(client, { queryKey: roleA, enabled: false });
  const unsubscribe = remounted.subscribe(() => undefined);
  assert.equal(remounted.getCurrentResult().data, null, "a remount does not clear the denial barrier");
  unsubscribe();

  await client.fetchQuery({ queryKey: roleA, queryFn: async () => ["fresh authorized response"] });
  assert.deepEqual(client.getQueryData(roleA), ["fresh authorized response"]);
  assert.equal(client.getQueryData(listA), null, "the separate list also needs a fresh authorized read");
  client.clear();
});

test("re-enabling a denied detail key fetches authorized data instead of treating null as fresh", { timeout: 1000 }, async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: Infinity } } });
  const deniedKey = permissionsQueryKeys.set("org", "role", "viewer");
  client.setQueryData(deniedKey, null);
  let reads = 0;
  const read = async () => { reads++; return ["fresh authorized detail"]; };
  const observer = new QueryObserver<string[] | null>(client, { queryKey: permissionsQueryKeys.set("org", "", "viewer"), enabled: false, staleTime: PERMISSION_READ_STALE_TIME, queryFn: read });
  let stop: () => void = () => undefined;
  const restored = new Promise<void>((resolve) => { stop = observer.subscribe((result) => { if (result.data?.[0] === "fresh authorized detail") resolve(); }); });
  observer.setOptions({ queryKey: deniedKey, enabled: true, staleTime: PERMISSION_READ_STALE_TIME, queryFn: read });
  await restored;
  assert.equal(reads, 1);
  assert.deepEqual(client.getQueryData(deniedKey), ["fresh authorized detail"]);
  stop();
  client.clear();
});

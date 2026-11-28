"use client";

import { useState } from "react";
import Link from "next/link";
import { getComputersRoute } from "../../../_lib/den-org";
import { focusRing, secondaryText } from "./computer-parts";
import { computersStateLine } from "./computers-format";
import { InventoryMergedSignIns, useInventoryActions } from "./inventory-actions";
import { useMyInventory, useRefreshInventory, type InventoryScope } from "./inventory-data";
import { InventoryDetail } from "./inventory-detail";
import { MY_INVENTORY_EMPTY } from "./inventory-format";
import { InventoryEmpty, InventoryError, InventoryHeader, inventoryText } from "./inventory-parts";
import { InventoryRows, InventoryRowsSkeleton } from "./inventory-rows";

export function MyInventoryScreen({ scope, orgSlug, canViewComputers }: { scope: InventoryScope; orgSlug: string | null; canViewComputers: boolean }) {
  const query = useMyInventory(scope);
  const refresh = useRefreshInventory(scope);
  const [openId, setOpenId] = useState("");
  const onRemoved = (id: string) => setOpenId((current) => current === id ? "" : current);
  const { removeSignIn } = useInventoryActions(scope);
  const data = query.data;
  const state = data ? computersStateLine({ total: data.computers.length, online: data.computers.filter((row) => row.status.state === "online").length }) : query.isPending ? null : undefined;
  const now = Date.now();

  return <section className={`min-w-0 ${inventoryText}`} data-testid="my-computer-inventory" aria-busy={query.isFetching}>
    <InventoryHeader title="My Computers" state={state} refreshing={query.isFetching} onRefresh={() => void refresh()} />
    {query.error ? <InventoryError message={query.error.message} stale={data ? "Showing the last known list." : undefined} checkedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} /> : null}
    {data ? data.computers.length ? <InventoryRows rows={data.computers} now={now} openId={openId}
      onToggle={(id) => setOpenId((current) => current === id ? "" : id)}
      detail={(row) => <InventoryDetail id={row.id} scope={scope} onRemoved={onRemoved} now={now} />} />
      : <InventoryEmpty>{MY_INVENTORY_EMPTY}</InventoryEmpty> : query.isPending ? <InventoryRowsSkeleton /> : null}
    {data ? <InventoryMergedSignIns signIns={data.mergedSignIns} now={now} onRemove={removeSignIn} /> : null}
    {canViewComputers ? <p className={`mt-4 text-xs leading-4 ${secondaryText}`}>
      Your whole team&apos;s computers are in <Link href={getComputersRoute(orgSlug)} className={`underline underline-offset-2 ${focusRing}`}>Manage &gt; Computers</Link>.
    </p> : null}
  </section>;
}

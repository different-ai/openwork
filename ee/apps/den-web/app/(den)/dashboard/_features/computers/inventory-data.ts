"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  computerInventoryDetailResponseSchema, myComputerInventoryResponseSchema, organizationComputerInventoryResponseSchema,
} from "@openwork/types/den/computer-inventory";
import { computerAccessSettingSchema, type ComputerAccessSetting } from "@openwork/types/den/computers";
import { requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import type { InventoryFilters } from "./inventory-format";

export type InventoryScope = { orgId: string; memberId: string; admin: boolean; orgName: string };

const inventoryKey = (scope: InventoryScope) => ["computer-inventory", scope.orgId, scope.memberId];
const inventoryPath = (admin: boolean) => admin ? "/v1/org/computers/inventory" : "/v1/computers/inventory";

function readFailure(status: number, detail: boolean) {
  if (status === 401) return "Your session expired. Sign in again to see computers.";
  if (status === 403) return "Access to Computers changed. Ask an organization owner or admin for access.";
  if (status === 404 && detail) return "This computer is no longer available.";
  return detail ? "Couldn't load this computer's details." : "Couldn't load computers.";
}

async function readInventory(scope: InventoryScope, path: string, signal: AbortSignal, detail = false) {
  try {
    const { response, payload } = await requestJson(path, {
      method: "GET", headers: { [ORG_SCOPE_HEADER]: scope.orgId }, cache: "no-store", signal,
    }, 15000);
    if (!response.ok) throw new Error(readFailure(response.status, detail));
    return payload;
  } catch (failure) {
    if (failure instanceof TypeError) throw new Error("Couldn't reach OpenWork. Check your connection and try again.");
    throw failure;
  }
}

export function useMyInventory(scope: InventoryScope) {
  const path = inventoryPath(false);
  return useQuery({
    queryKey: [...inventoryKey(scope), path], retry: false,
    queryFn: async ({ signal }) => {
      const result = myComputerInventoryResponseSchema.safeParse(await readInventory(scope, path, signal));
      if (!result.success) throw new Error("Couldn't read your computer list.");
      return result.data;
    },
  });
}

export function useOrganizationInventory(scope: InventoryScope, filters: InventoryFilters) {
  const params = new URLSearchParams({ tab: filters.tab, page: String(filters.page) });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.older) params.set("older", "include");
  const path = `${inventoryPath(true)}?${params}`;
  return useQuery({
    queryKey: [...inventoryKey(scope), path], retry: false, placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const result = organizationComputerInventoryResponseSchema.safeParse(await readInventory(scope, path, signal));
      if (!result.success) throw new Error("Couldn't read the computer list.");
      return result.data;
    },
  });
}

export function useInventoryDetail(scope: InventoryScope, id: string) {
  const path = `${inventoryPath(scope.admin)}/${encodeURIComponent(id)}`;
  return useQuery({
    queryKey: [...inventoryKey(scope), path], retry: false,
    queryFn: async ({ signal }) => {
      const result = computerInventoryDetailResponseSchema.safeParse(await readInventory(scope, path, signal, true));
      if (!result.success) throw new Error("Couldn't read this computer's details.");
      return result.data;
    },
  });
}

export function useRefreshInventory(scope: InventoryScope) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: inventoryKey(scope) });
}

export async function saveWholeComputerChoice(orgId: string, id: string, input: ComputerAccessSetting) {
  const choice = computerAccessSettingSchema.safeParse(input);
  if (!choice.success) throw new Error("Enter a full folder path, such as /home/openwork.");
  const { response } = await requestJson(`/v1/computers/${encodeURIComponent(id)}/access`, {
    method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", body: JSON.stringify(choice.data),
  }, 15000);
  if (response.status === 401) throw new Error("Your session expired. Sign in again to change this setting.");
  if (response.status === 404 || response.status === 409) throw new Error("This computer can no longer be changed here. Refresh to see what changed.");
  if (!response.ok) throw new Error(choice.data.choice === "allow" ? "Couldn't allow whole-computer access. Try again." : "Couldn't turn off whole-computer access. Try again.");
}

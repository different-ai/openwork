"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export type AdminDataSection = "overview" | "users" | "organizations";
export const ADMIN_LIST_PAGE_SIZE = 50;
const MAX_PAGE = 2001;

export function readAdminListLocation(params: { get: (key: string) => string | null }) {
  const rawPage = params.get("page") ?? "1";
  const value = /^[1-9]\d*$/.test(rawPage) ? Number(rawPage) : 1;
  const page = Number.isSafeInteger(value) ? Math.min(MAX_PAGE, value) : 1;
  return { search: params.get("search") ?? "", page, offset: (page - 1) * ADMIN_LIST_PAGE_SIZE };
}

function organizationsListHref(search: string, page: number) {
  const query = new URLSearchParams();
  if (search) query.set("search", search.slice(0, 160));
  if (page > 1) query.set("page", String(Math.min(MAX_PAGE, page)));
  return `/admin/organizations${query.size ? `?${query}` : ""}`;
}

export function adminOrganizationHref(organizationId: string, search: string, page: number, section?: "features" | "billing") {
  const returnTo = organizationsListHref(search, page);
  const query = new URLSearchParams();
  if (returnTo !== "/admin/organizations") query.set("returnTo", returnTo);
  return `/admin/organizations/${encodeURIComponent(organizationId)}${section ? `/${section}` : ""}${query.size ? `?${query}` : ""}`;
}

/** Only the organization list's search and page can be used as a parent link. */
function organizationsReturnHref(params: { get: (key: string) => string | null }) {
  const returnTo = params.get("returnTo") ?? "";
  const separator = returnTo.indexOf("?");
  if (separator < 0 || returnTo.slice(0, separator) !== "/admin/organizations") return "/admin/organizations";
  const { search, page } = readAdminListLocation(new URLSearchParams(returnTo.slice(separator + 1)));
  return organizationsListHref(search, page);
}

export function adminDataEndpoint(section: AdminDataSection, params: { get: (key: string) => string | null }) {
  if (section === "overview") return "/v1/admin/overview?limit=1";
  const { search, offset } = readAdminListLocation(params);
  const query = new URLSearchParams({ limit: String(ADMIN_LIST_PAGE_SIZE), offset: String(offset) });
  if (search.trim()) query.set("search", search.trim());
  if (section === "organizations") query.set("includeFeatures", "0");
  return `/v1/admin/${section}?${query}`;
}

/** URL state is shared by direct entry, refresh, navigation and browser history. */
export function useAdminListLocation() {
  const params = useSearchParams();
  const { search, page, offset } = readAdminListLocation(params);
  const [draftSearch, setDraftSearch] = useState(search);
  useEffect(() => { setDraftSearch(search); }, [search]);

  const updateLocation = useCallback((nextSearch: string, nextPage: number, history: "push" | "replace") => {
    const query = new URLSearchParams(window.location.search);
    if (nextSearch) query.set("search", nextSearch); else query.delete("search");
    if (nextPage > 1) query.set("page", String(Math.min(MAX_PAGE, nextPage))); else query.delete("page");
    const href = `${window.location.pathname}${query.size ? `?${query}` : ""}`;
    // Native history integrates with Next's useSearchParams without rerunning
    // the access request for every search keystroke.
    if (history === "push") window.history.pushState(null, "", href);
    else window.history.replaceState(null, "", href);
  }, []);

  const setSearch = useCallback((value: string) => {
    setDraftSearch(value);
    updateLocation(value, 1, "replace");
  }, [updateLocation]);
  const setPage = useCallback((value: number) => updateLocation(search, value, "push"), [search, updateLocation]);
  return { search, draftSearch, page, offset, setSearch, setPage, organizationsHref: organizationsReturnHref(params) };
}

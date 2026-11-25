"use client";

import { useQuery } from "@tanstack/react-query";
import { EndedSandboxNotice } from "@openwork/ui/sandbox-trial-notice";
import { memberSandboxStatusSchema } from "@openwork/types/den/sandbox-organizations";
import { requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

export function SandboxTrialNotice({ orgId, memberId }: { orgId: string; memberId: string }) {
  const query = useQuery({
    queryKey: ["sandbox-status", orgId, memberId],
    queryFn: async ({ signal }) => {
      const { response, payload } = await requestJson("/v1/org/sandbox-status", {
        method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal,
      });
      if (!response.ok) throw new Error("Sandbox status unavailable");
      return memberSandboxStatusSchema.parse(payload).state;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  return <EndedSandboxNotice state={query.isError ? null : query.data} className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-800 md:px-6" />;
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useDenFlow } from "../_providers/den-flow-provider";
import { requestJson } from "./den-flow";
import { parseInferenceAccessPayload } from "./inference-status";

export function useInferenceAccess(orgId: string | null) {
  const { user } = useDenFlow();
  return useQuery({
    queryKey: ["inference-access", user?.id, orgId],
    enabled: Boolean(user && orgId),
    queryFn: async ({ signal }) => {
      if (!orgId) return null;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const timeout = setTimeout(cancel, 12_000);
      try {
        const { response, payload } = await requestJson("/v1/inference/access", {
          method: "GET", signal: controller.signal, headers: { "x-openwork-org-id": orgId },
        }, 12_000);
        // Older deployments and disabled offers must not advertise free access.
        return response.ok ? parseInferenceAccessPayload(payload) : null;
      } catch { return null; }
      finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
    },
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

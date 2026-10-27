import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature";

/** An organization override must never fall back to a deployment-wide grant. */
export function useNativeDictationFeature() {
  const auth = useDenAuth();
  const context = useAutomationsDenContext();
  const baseUrl = readDenSettings().baseUrl;
  const client = useMemo(() => createDenClient({ baseUrl }), [baseUrl]);
  const organization = useOrgFeature("nativeDictation");
  const signedOut = auth.status === "signed_out" && !context.ready;
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => client.getDeploymentFeatures(),
    enabled: signedOut,
    staleTime: 30_000,
    retry: false,
    refetchInterval: signedOut ? 60_000 : false,
    select: features => features.nativeDictation === true,
  });
  return context.ready ? organization : signedOut && !deployment.isError && deployment.data === true;
}

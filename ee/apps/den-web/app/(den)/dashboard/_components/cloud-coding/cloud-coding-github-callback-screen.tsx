"use client";

import { cloudCodingGithubCallbackInputSchema } from "@openwork/types/den/cloud-coding";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { getCloudCodingRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { CloudCodingGithubCallbackError, useCloudCodingGithubCallback } from "./cloud-coding-data";
import { CloudCodingGithubCallbackView } from "./cloud-coding-github-callback-view";

export function parseGithubCallbackParams(params: Pick<URLSearchParams, "get">) {
  const installationId = params.get("installation_id");
  const parsed = cloudCodingGithubCallbackInputSchema.safeParse({
    code: params.get("code"),
    state: params.get("state"),
    ...(installationId === null ? {} : { installationId: /^\d+$/.test(installationId) ? Number(installationId) : NaN }),
  });
  return parsed.success ? parsed.data : null;
}

const cloudCodingRoute = getCloudCodingRoute();

export function CloudCodingGithubCallbackScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { orgId } = useOrgDashboard();
  const input = parseGithubCallbackParams(params);
  const { data, error } = useCloudCodingGithubCallback(orgId ?? "", orgId ? input : null);
  const navigatedCode = useRef<string | null>(null);
  const code = input?.code;
  const installUrl = data?.outcome === "install" && data.redirectUrl && /^https?:\/\//i.test(data.redirectUrl) ? data.redirectUrl : null;

  useEffect(() => {
    if (!data || !code || navigatedCode.current === code) return;
    if (data.outcome === "install" && !installUrl) return;
    navigatedCode.current = code;
    if (installUrl) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      window.location.assign(installUrl);
    } else if (data.outcome === "linked") {
      router.replace(`${cloudCodingRoute}/link?github=linked`);
    } else {
      router.replace(`${cloudCodingRoute}?github=${data.outcome}`);
    }
  }, [code, data, installUrl, router]);

  const reason = !input ? "state_invalid"
    : error instanceof CloudCodingGithubCallbackError ? error.reason
    : error || (data?.outcome === "install" && !installUrl) ? "github_error" : null;

  return <CloudCodingGithubCallbackView phase={reason === null ? "working" : "error"} reason={reason} onBack={() => router.replace(cloudCodingRoute)} />;
}

"use client";

import {
  featureIntroEventResponseSchema,
  featureIntroListResponseSchema,
  type FeatureIntroEventRequest,
  type FeatureIntroState,
} from "@openwork/types/den/feature-intros";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { applyIntroEvent } from "./model";
import type { FeatureIntroKey } from "./types";

/** Per member and organization: which intros were seen, dismissed or acted on (`/v1/me/feature-intros`). */
const featureIntrosPath = "/v1/me/feature-intros";

export function featureIntroStatesQueryKey(orgId: string): string[] {
  return ["feature-intros", orgId];
}

/** Loads only while the `featureIntros` flag is on for the organization. */
export function useFeatureIntroStates(orgId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: featureIntroStatesQueryKey(orgId ?? ""),
    enabled: enabled && Boolean(orgId),
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<FeatureIntroState[]> => {
      const { response, payload } = await requestJson(
        featureIntrosPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId ?? "" }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load feature intros (${response.status}).`));
      const parsed = featureIntroListResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Feature intros returned an unexpected response.");
      return parsed.data.intros;
    },
  });
}

export type FeatureIntroEvent = Omit<FeatureIntroEventRequest, "introKey"> & { introKey: FeatureIntroKey };

/**
 * Records seen / dismissed / cta_clicked. Updates the cached states first so
 * dots and banners react at once; a failed write rolls back quietly.
 */
export function useFeatureIntroEvent(orgId: string | null) {
  const queryClient = useQueryClient();
  const key = featureIntroStatesQueryKey(orgId ?? "");
  return useMutation({
    mutationKey: [...key, "event"],
    retry: false,
    mutationFn: async (event: FeatureIntroEvent): Promise<FeatureIntroState | null> => {
      if (!orgId) return null;
      const { response, payload } = await requestJson(
        `${featureIntrosPath}/events`,
        { method: "POST", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(event) },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't save feature intro (${response.status}).`));
      const parsed = featureIntroEventResponseSchema.safeParse(payload);
      return parsed.success ? parsed.data.intro : null;
    },
    onMutate: async (event) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<FeatureIntroState[]>(key);
      queryClient.setQueryData<FeatureIntroState[]>(key, (current) =>
        applyIntroEvent(current ?? [], event, new Date().toISOString()),
      );
      return { previous };
    },
    onError: (_error, _event, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (saved) => {
      if (!saved) return;
      queryClient.setQueryData<FeatureIntroState[]>(key, (current) => [
        ...(current ?? []).filter((state) => state.introKey !== saved.introKey),
        saved,
      ]);
    },
  });
}

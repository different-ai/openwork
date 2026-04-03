"use client";

import { useEffect, useState } from "react";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { OPENWORK_FEEDBACK_URL, buildDenFeedbackUrl } from "../../../../_lib/feedback";

export const OPENWORK_DOCS_URL = "https://openworklabs.com/docs";
export { OPENWORK_FEEDBACK_URL, buildDenFeedbackUrl };

export function formatTemplateTimestamp(value: string | null, options?: { includeTime?: boolean }) {
  if (!value) {
    return "Recently updated";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently updated";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(options?.includeTime
      ? {
          hour: "numeric",
          minute: "2-digit",
        }
      : {}),
  }).format(date);
}

export type TemplateCard = {
  id: string;
  name: string;
  createdAt: string | null;
  creator: {
    name: string;
    email: string;
  };
};

function asTemplateCard(value: unknown): TemplateCard | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const creator = entry.creator && typeof entry.creator === "object"
    ? (entry.creator as Record<string, unknown>)
    : null;

  if (
    typeof entry.id !== "string" ||
    typeof entry.name !== "string" ||
    !creator ||
    typeof creator.name !== "string" ||
    typeof creator.email !== "string"
  ) {
    return null;
  }

  return {
    id: entry.id,
    name: entry.name,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
    creator: {
      name: creator.name,
      email: creator.email,
    },
  };
}

export function useOrgTemplates(orgId: string | null) {
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadTemplates() {
    setBusy(true);
    setError(null);
    try {
      if (!orgId) {
        setTemplates([]);
        setError("Organization not found.");
        return;
      }

      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgId)}/templates`,
        { method: "GET" },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load templates (${response.status}).`));
      }

      const list =
        payload && typeof payload === "object" && Array.isArray((payload as { templates?: unknown[] }).templates)
          ? (payload as { templates: unknown[] }).templates
          : [];

      setTemplates(list.map(asTemplateCard).filter((entry): entry is TemplateCard => entry !== null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load templates.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadTemplates();
  }, [orgId]);

  return {
    templates,
    busy,
    error,
    reloadTemplates: loadTemplates,
  };
}

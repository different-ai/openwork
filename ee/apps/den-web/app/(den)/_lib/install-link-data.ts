import { getErrorMessage, requestJson } from "./den-flow";

function getInstallPageUrl(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("installPageUrl" in payload)) {
    return null;
  }

  const installPageUrl = payload.installPageUrl;
  return typeof installPageUrl === "string" && installPageUrl.trim()
    ? installPageUrl.trim()
    : null;
}

function installPageUrlOnCurrentOrigin(value: string) {
  if (typeof window === "undefined") {
    return value;
  }

  const parsed = new URL(value);
  if (parsed.pathname.replace(/\/+$/, "") !== "/install") {
    return value;
  }

  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, window.location.origin).toString();
}

export async function createOrganizationInstallLink(organizationId: string, rotate = false) {
  const { response, payload } = await requestJson(
    `/v1/orgs/${encodeURIComponent(organizationId)}/install-links`,
    { method: "POST", body: JSON.stringify({ rotate }) },
    12000,
  );

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Could not create install link (${response.status}).`));
  }

  const installPageUrl = getInstallPageUrl(payload);
  if (!installPageUrl) {
    throw new Error("The install link response was incomplete.");
  }

  return installPageUrlOnCurrentOrigin(installPageUrl);
}

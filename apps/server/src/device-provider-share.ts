import { deviceShareOptionsSchema, deviceShareProviderName } from "@openwork/types/den/device-provider-share";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import { ApiError } from "./errors.js";

/**
 * Share an API key saved on this computer with the signed-in person's
 * organization (Den feature `shareDeviceProvider`).
 *
 * The person confirms in the app; the app then asks this server, which reads
 * the key from this computer's own credential store and sends it straight to
 * the Den it is signed in to. The key never passes through the app's window,
 * is never logged and is never returned.
 *
 * Den decides everything else: whether the feature is on, whether the person
 * manages AI Gateway, whether the provider can be served from one key and
 * whether the organization already has it. This server only asks first, so a
 * key is never sent when the answer would be no.
 */

const REQUEST_TIMEOUT_MS = 15_000;
// Provider ids as OpenCode and the model catalog write them. Organization-managed
// ids (lpr_, ipr_, openwork…) are never keys of this computer.
const DEVICE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ORGANIZATION_PROVIDER_ID = /^(?:lpr|ipr)_|^openwork(?:-|$)/;

export type DeviceProviderShareResult = {
  /** The organization's new AI Gateway provider. */
  inferenceProviderId: string;
  name: string;
};

type Input = {
  session: CloudProviderDenSession;
  providerId: string;
  fetchImpl?: typeof globalThis.fetch;
  /** The API key saved on this computer for a provider id, or null. */
  readApiKey: (providerId: string) => Promise<string | null>;
  signal?: AbortSignal;
  /** A newer sign-in from the same person's browser verification. Never changes the destination or organization. */
  verifiedToken?: string;
  /** Checked again before reading and before sending the key, after asynchronous work. */
  isCurrentSession?: () => boolean;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Den's error code from `{ error }` or `{ error: { code } }`. */
function denErrorCode(body: unknown): string | null {
  if (!record(body)) return null;
  if (typeof body.error === "string") return body.error;
  return record(body.error) && typeof body.error.code === "string" ? body.error.code : null;
}

async function denRequest(input: Input, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${input.session.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.session.token}`,
        "x-openwork-org-id": input.session.orgId,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      // A key is only ever sent to the Den this computer is signed in to.
      redirect: "error",
    });
  } catch {
    // A lost POST response is not evidence that the transaction rolled back.
    throw init.method === "POST"
      ? new ApiError(502, "share_unconfirmed", "OpenWork Cloud did not confirm the share. Check AI Providers before trying again.")
      : new ApiError(502, "den_unreachable", "Could not reach OpenWork Cloud. Nothing was shared.");
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

function refused(status: number, body: unknown): ApiError {
  const code = denErrorCode(body);
  if (status === 401) return new ApiError(401, "no_session", "Sign in to OpenWork again, then share.");
  if (status === 409 && code === "already_shared") return new ApiError(409, "already_shared", "Your organization already has this provider.");
  if (status === 403 && code === "reauth") return new ApiError(403, "verification_required", "Confirm it's you in your browser, then share.");
  if (status === 403 && code === "gateway_not_enabled") return new ApiError(409, "gateway_unavailable", "AI Gateway is not set up for this OpenWork yet.");
  if (status === 403) return new ApiError(403, "forbidden", "Only people who manage AI Gateway can share a provider.");
  if (status === 404 && code === "feature_disabled") return new ApiError(404, "feature_disabled", "Sharing from this device is not available for your organization.");
  return new ApiError(502, "share_failed", "OpenWork Cloud could not share this provider. Nothing was shared.");
}

export async function shareDeviceProvider(input: Input): Promise<DeviceProviderShareResult> {
  const assertCurrent = () => {
    if (input.isCurrentSession?.() === false) throw new ApiError(409, "organization_mismatch", "Your account or organization changed. Nothing was shared.");
  };
  assertCurrent();
  const providerId = input.providerId.trim();
  if (!DEVICE_PROVIDER_ID.test(providerId) || ORGANIZATION_PROVIDER_ID.test(providerId)) {
    throw new ApiError(400, "invalid_provider", "A provider connected on this device is required");
  }

  // A browser reauthentication token is not an authority to substitute another
  // account. Verify both against the same Den before reading any device key.
  if (input.verifiedToken && input.verifiedToken !== input.session.token) {
    const verified = { ...input, session: { ...input.session, token: input.verifiedToken } };
    const [originalUser, verifiedUser] = await Promise.all([
      denRequest(input, "/v1/me", { method: "GET" }),
      denRequest(verified, "/v1/me", { method: "GET" }),
    ]);
    const userId = (body: unknown) => record(body) && record(body.user) && typeof body.user.id === "string" ? body.user.id : null;
    const originalId = userId(originalUser.body);
    if (originalUser.status !== 200 || verifiedUser.status !== 200 || !originalId || originalId !== userId(verifiedUser.body)) {
      throw new ApiError(403, "account_mismatch", "Verify with the account already signed in on this device.");
    }
    input = verified;
  }
  assertCurrent();
  const asked = await denRequest(input, `/v1/inference-providers/device-share-options?providerIds=${encodeURIComponent(providerId)}`, { method: "GET" });
  if (asked.status !== 200) throw refused(asked.status, asked.body);
  const options = deviceShareOptionsSchema.safeParse(asked.body);
  if (!options.success) throw new ApiError(502, "share_failed", "OpenWork Cloud could not share this provider. Nothing was shared.");
  if (!options.data.canShare) {
    throw options.data.blocker === "gateway_unavailable"
      ? new ApiError(409, "gateway_unavailable", "AI Gateway is not set up for this OpenWork yet.")
      : new ApiError(403, "forbidden", "Only people who manage AI Gateway can share a provider.");
  }
  const provider = options.data.providers.find((entry) => entry.providerId === providerId);
  if (provider?.status === "shared") throw new ApiError(409, "already_shared", "Your organization already has this provider.");
  if (provider?.status !== "shareable") throw new ApiError(409, "not_shareable", "This provider can't be shared from this device. Add it in AI Gateway instead.");

  if (options.data.verificationRequired) throw new ApiError(403, "verification_required", "Confirm it's you in your browser, then share.");
  // Only now, with Den's yes and the same account/organization, read the key.
  assertCurrent();
  const apiKey = (await input.readApiKey(providerId))?.trim();
  if (!apiKey) throw new ApiError(409, "no_device_key", "No API key for this provider is saved on this device.");
  assertCurrent();

  const name = deviceShareProviderName(provider.name, providerId);
  const created = await denRequest(input, "/v1/inference-providers", {
    method: "POST",
    body: { name, providerId, credential: { kind: "api_key", secret: apiKey }, allMembers: true, shareFromDevice: true },
  });
  if (created.status >= 500) throw new ApiError(502, "share_unconfirmed", "OpenWork Cloud did not confirm the share. Check AI Providers before trying again.");
  if (created.status !== 201) throw refused(created.status, created.body);
  const inferenceProvider = record(created.body) && record(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
  const inferenceProviderId = inferenceProvider && typeof inferenceProvider.id === "string" ? inferenceProvider.id : null;
  if (!inferenceProviderId) throw new ApiError(502, "share_unconfirmed", "OpenWork Cloud did not confirm the share. Check AI Providers before trying again.");
  return { inferenceProviderId, name: typeof inferenceProvider?.name === "string" ? inferenceProvider.name : name };
}

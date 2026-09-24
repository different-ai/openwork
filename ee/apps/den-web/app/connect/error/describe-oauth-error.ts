/**
 * Copy for the OAuth error page that Better Auth redirects to when an
 * authorization request cannot continue and there is no trusted redirect URI
 * to return the error to (DESIGN.md C6: what happened + the next action).
 */
export type OAuthErrorPageState = {
  code: string;
  title: string;
  description: string;
  detail: string | null;
  advice: string[];
};

const KNOWN: Record<string, { title: string; description: string; advice: string[] }> = {
  invalid_redirect: {
    title: "The app's return address isn't registered",
    description: "OpenWork can't send you back to the app because it asked to return to an address it hasn't registered.",
    advice: [
      "Ask the app's developer to register the return address it uses, then connect again.",
      "If you built the app, add the address to its OAuth client or metadata document.",
    ],
  },
  invalid_client: {
    title: "OpenWork doesn't recognize this app",
    description: "The app started sign-in with a client ID that OpenWork can't find or fetch.",
    advice: [
      "Go back to the app and connect again.",
      "If it keeps happening, share the technical details with the app's developer.",
    ],
  },
  client_disabled: {
    title: "This app has been turned off",
    description: "An administrator disabled sign-in for this app.",
    advice: ["Contact your OpenWork administrator if you need this app back."],
  },
  unauthorized_client: {
    title: "This app can't use this sign-in method",
    description: "The app is registered, but not for the kind of sign-in it asked for.",
    advice: ["Share the technical details with the app's developer."],
  },
};

const MALFORMED = new Set([
  "invalid_request",
  "unsupported_response_type",
  "request_not_supported",
  "request_uri_not_supported",
  "invalid_request_uri",
  "unsupported_prompt_select_account",
]);

const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export function describeOAuthError(params: URLSearchParams): OAuthErrorPageState {
  const raw = params.get("error")?.trim() ?? "";
  const code = SAFE_CODE.test(raw) ? raw : "unknown";
  const rawDetail = params.get("error_description")?.trim() ?? "";
  const detail = rawDetail ? rawDetail.slice(0, 500) : null;
  const known = KNOWN[code];
  if (known) return { code, detail, ...known };
  if (MALFORMED.has(code)) {
    return {
      code,
      detail,
      title: "The sign-in request was malformed",
      description: "The app sent a sign-in request OpenWork can't process.",
      advice: ["Go back to the app and connect again.", "If it keeps happening, share the technical details with the app's developer."],
    };
  }
  return {
    code,
    detail,
    title: "Sign-in couldn't be completed",
    description: "OpenWork stopped this sign-in before it finished.",
    advice: ["Go back to the app and try again.", "If it keeps happening, share the technical details with the app's developer."],
  };
}

/** Native UI only: this bridge must never be registered as an agent tool. */
export type MemberApiKeyFailure = {
  ok: false;
  code: "unavailable" | "invalid_input" | "context_changed" | "expired" | "busy"
    | "forbidden" | "uncertain";
};

export type MemberApiKeyContext = {
  handle: string;
  connectionId: string;
  connectionName: string;
  organizationId: string;
  memberId: string;
};

export type MemberApiKeyBridge = {
  prepare(connectionId: string): Promise<{ ok: true; context: MemberApiKeyContext } | MemberApiKeyFailure>;
  submit(handle: string, apiKey: string): Promise<{ ok: true; saved: true } | MemberApiKeyFailure>;
  cancel(handle: string): Promise<void>;
};

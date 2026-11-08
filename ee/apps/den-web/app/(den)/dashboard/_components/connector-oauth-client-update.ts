/** Only resubmit an unchanged OAuth app when the admin explicitly confirms a required callback update. */
export function connectorOAuthClientUpdate(input: {
  clientChanged: boolean;
  callbackUpdateRequired: boolean;
  callbackUpdateConfirmed: boolean;
  clientId: string;
  clientSecret: string;
}): { clientId: string; clientSecret?: string } | undefined {
  const clientId = input.clientId.trim();
  if (!clientId || (!input.clientChanged && !(input.callbackUpdateRequired && input.callbackUpdateConfirmed))) return undefined;
  const clientSecret = input.clientSecret.trim();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

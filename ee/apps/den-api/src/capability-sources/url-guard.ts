/**
 * Den keeps this compatibility module so existing imports and focused tests
 * exercise the package-owned egress policy used by every Connect host.
 */
export {
  PrivateUrlError,
  MCP_OUTBOUND_RESPONSE_LIMIT_BYTES,
  assertPublicUrl,
  assertRealmUrl,
  createGuardedFetch,
  createRealmSafeFetch,
  isPrivateAddress,
  normalizeResponseRealm,
} from "@openwork/enterprise-mcp-client"

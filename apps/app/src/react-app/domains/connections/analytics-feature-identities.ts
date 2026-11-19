import { getMcpServerName, isBuiltInOpenWorkExtension, MCP_QUICK_CONNECT, type McpDirectoryInfo } from "../../../app/constants";
import type { ConnectorAnalyticsIdentity } from "@openwork/product-analytics";

export function connectorAnalyticsIdentity(entry: McpDirectoryInfo): ConnectorAnalyticsIdentity {
  const catalog = MCP_QUICK_CONNECT.find((candidate) => candidate === entry && isBuiltInOpenWorkExtension(candidate));
  return catalog ? { connector_kind: "catalog", connector_id: catalog.id ?? getMcpServerName(catalog) } : { connector_kind: "custom" };
}

import type { McpUiResourceMeta, McpUiToolMeta } from "@modelcontextprotocol/ext-apps"
import type {
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  RegisteredTool,
  ResourceMetadata,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server"
import type { ZodType } from "zod"

export const EXTENSION_ID = "io.modelcontextprotocol/ui"
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
const RESOURCE_URI_META_KEY = "ui/resourceUri"

type AppToolConfig<InputArgs extends ZodType | undefined, OutputArgs extends ZodType> = {
  title?: string
  description?: string
  inputSchema?: InputArgs
  outputSchema?: OutputArgs
  annotations?: ToolAnnotations
  _meta: Record<string, unknown> & {
    ui?: McpUiToolMeta
    [RESOURCE_URI_META_KEY]?: string
  }
}

/**
 * MCP Apps' published helper is still typed against SDK v1. This v2 adapter
 * preserves its metadata normalization while registering directly on the v2
 * server. Remove it once ext-apps publishes a v2-compatible server helper.
 */
export function registerAppTool<
  InputArgs extends ZodType | undefined = undefined,
  OutputArgs extends ZodType = ZodType,
>(
  server: McpServer,
  name: string,
  config: AppToolConfig<InputArgs, OutputArgs>,
  callback: ToolCallback<InputArgs>,
): RegisteredTool {
  const ui = config._meta.ui
  const legacyResourceUri = config._meta[RESOURCE_URI_META_KEY]
  const normalizedMeta = ui?.resourceUri && !legacyResourceUri
    ? { ...config._meta, [RESOURCE_URI_META_KEY]: ui.resourceUri }
    : legacyResourceUri && !ui?.resourceUri
      ? { ...config._meta, ui: { ...ui, resourceUri: legacyResourceUri } }
      : config._meta

  return server.registerTool(
    name,
    { ...config, _meta: normalizedMeta },
    callback,
  )
}

type AppResourceConfig = ResourceMetadata & {
  _meta?: Record<string, unknown> & { ui?: McpUiResourceMeta }
}

export function registerAppResource(
  server: McpServer,
  name: string,
  uri: string,
  config: AppResourceConfig,
  callback: ReadResourceCallback,
): RegisteredResource {
  return server.registerResource(name, uri, {
    mimeType: RESOURCE_MIME_TYPE,
    ...config,
  }, callback)
}

import { normalizeServerBaseUrl } from "../client.js";
import type { OpenWorkServerV2WorkspaceEvent } from "../../generated/types.gen";
import {
  createOpenWorkServerEventStream,
  type OpenWorkServerEventStreamOptions,
  type OpenWorkServerEventStreamResult,
} from "./sse.js";

export type OpenWorkServerWorkspaceEvent = OpenWorkServerV2WorkspaceEvent;

export type OpenWorkServerWorkspaceEventStreamOptions = Omit<
  OpenWorkServerEventStreamOptions<OpenWorkServerWorkspaceEvent>,
  "url"
> & {
  baseUrl: string;
  workspaceId: string;
};

export type OpenWorkServerWorkspaceEventStreamResult = OpenWorkServerEventStreamResult<OpenWorkServerWorkspaceEvent>;

export function createOpenWorkServerWorkspaceEventStream(
  options: OpenWorkServerWorkspaceEventStreamOptions,
): OpenWorkServerWorkspaceEventStreamResult {
  const baseUrl = normalizeServerBaseUrl(options.baseUrl);
  const url = `${baseUrl}/workspaces/${encodeURIComponent(options.workspaceId)}/events`;
  return createOpenWorkServerEventStream<OpenWorkServerWorkspaceEvent>({
    ...options,
    url,
  });
}

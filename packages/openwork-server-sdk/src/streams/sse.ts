import { createSseClient } from "../../generated/core/serverSentEvents.gen";
import type { ServerSentEventsOptions, ServerSentEventsResult, StreamEvent } from "../../generated/core/serverSentEvents.gen";

export type OpenWorkServerEventStreamOptions<TData = unknown> = ServerSentEventsOptions<TData>;
export type OpenWorkServerEventStreamResult<TData = unknown> = ServerSentEventsResult<TData>;
export type OpenWorkServerStreamEvent<TData = unknown> = StreamEvent<TData>;

export function createOpenWorkServerEventStream<TData = unknown>(options: OpenWorkServerEventStreamOptions<TData>) {
  return createSseClient<TData>(options as ServerSentEventsOptions<unknown>) as OpenWorkServerEventStreamResult<TData>;
}

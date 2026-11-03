import type { EventEmitter } from "node:events"

/** The viewer's side of the stream: a WebSocket from `ws`, or anything shaped like one. */
export type ScreencastViewer = EventEmitter & { readyState: number; send(message: string | Buffer): void }

export function streamBrowser(viewer: ScreencastViewer, options?: { endpoint?: string; control?: boolean; pollMs?: number; quality?: number; maxWidth?: number; maxHeight?: number; onClose?(): void }): () => void

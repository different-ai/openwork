import { useEffect, useRef } from "react";
import { useOpenTargets } from "@/lib/target-provider";
import { attachVideoSource } from "@/lib/video-source";

export function VideoAttachment({ src, title, mediaType }: { src: string; title: string; mediaType: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const noticeRef = useRef<HTMLSpanElement>(null);
  const { client, workspaceId, workspaceRoot } = useOpenTargets();
  useEffect(() => {
    if (!videoRef.current || !noticeRef.current) return;
    return attachVideoSource(videoRef.current, noticeRef.current, { href: src, mediaType, client, workspaceId, workspaceRoot });
  }, [src, mediaType, client, workspaceId, workspaceRoot]);

  return (
    <div className="w-full min-w-0 max-w-lg">
      <video ref={videoRef} controls playsInline preload="metadata" aria-label={title} className="block max-h-80 w-full rounded-lg border border-border/70 bg-black" />
      <span ref={noticeRef} role="status" className="text-sm text-muted-foreground">Loading video...</span>
    </div>
  );
}

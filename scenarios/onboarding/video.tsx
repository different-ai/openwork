import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import {
  BrowserFrame,
  DownloadToast,
  RecordedBrowser,
  mix,
} from "@openwork/presentation";
import type { BrowserRecording } from "@openwork/presentation";
import { EmptyChat } from "./empty-chat.tsx";

export type OnboardingVideoProps = { recording: BrowserRecording };

export function OnboardingVideo({ recording }: OnboardingVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = Math.min(frame / fps, recording.durationSeconds);
  const openingFrame = Math.ceil((recording.durationSeconds + 2) * fps);
  const opening = frame >= openingFrame;
  const download = recording.downloads.findLast(
    (event) => event.seconds <= seconds,
  );
  const complete = download?.state === "completed";
  const progress =
    download && download.totalBytes > 0
      ? download.receivedBytes / download.totalBytes
      : 0;

  return (
    <AbsoluteFill
      style={{
        background: "#f4f6ef",
        overflow: "hidden",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      }}
    >
      <div
        style={{
          width: 1600,
          height: 1000,
          position: "relative",
          transform: "scale(1.2)",
          transformOrigin: "0 0",
        }}
      >
        <div
          style={{
            opacity: opening
              ? mix(frame, openingFrame, openingFrame + 24, 1, 0)
              : 1,
          }}
        >
          <BrowserFrame
            section="Get started"
            address="OpenWork"
            download={
              download && (
                <DownloadToast
                  f={30}
                  progress={progress}
                  complete={complete}
                  bytes={download.totalBytes}
                />
              )
            }
          >
            <RecordedBrowser recording={recording} seconds={seconds} />
          </BrowserFrame>
        </div>
        {opening && (
          <div style={{ position: "absolute", inset: 0 }}>
            <EmptyChat f={frame - openingFrame} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

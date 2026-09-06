import { Img, staticFile } from "remotion";
import { frameAt } from "./recording.ts";
import type { BrowserRecording } from "./recording.ts";

export function RecordedBrowser({
  recording,
  seconds,
}: {
  recording: BrowserRecording;
  seconds: number;
}) {
  return (
    <Img
      src={staticFile(frameAt(recording.frames, seconds).file)}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        objectFit: "contain",
      }}
    />
  );
}

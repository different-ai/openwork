import { Composition, registerRoot } from "remotion";
import { OnboardingVideo } from "./video.tsx";

registerRoot(() => (
  <Composition
    id="Onboarding"
    component={OnboardingVideo}
    width={1920}
    height={1200}
    fps={30}
    durationInFrames={240}
    defaultProps={{
      recording: { frames: [], downloads: [], durationSeconds: 0 },
    }}
    calculateMetadata={({ props }) => {
      if (props.recording.frames.length === 0)
        throw new Error(
          "Use onboarding/render.mjs with a completed capture directory",
        );
      return {
        durationInFrames: Math.ceil((props.recording.durationSeconds + 8) * 30),
      };
    }}
  />
));

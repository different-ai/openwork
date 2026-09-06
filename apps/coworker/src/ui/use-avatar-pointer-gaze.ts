import { useAvatarMotion } from "@openwork/ui/coworker-motion";

/** The brand keeps its call signature while sharing the avatar lifecycle. */
export function useAvatarPointerGaze(enabled = true, ambient = false, intensity = 1) {
  return useAvatarMotion({
    identity: "open-coworker-mark",
    animated: enabled || ambient,
    gaze: enabled,
    motion: "attentive",
    intensity,
  });
}

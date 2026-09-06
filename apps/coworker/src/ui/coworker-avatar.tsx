import { CoworkerAvatar as AvatarArt, type AvatarColor, type AvatarGlasses } from "@openwork/ui/coworker";
import { useAvatarPointerGaze } from "@/ui/use-avatar-pointer-gaze";

export { AvatarControls } from "@openwork/ui/coworker";

/** Desktop gaze wraps the artwork shared with the product walkthrough. */
export function CoworkerAvatar({ name, color, glasses, size = 96, animated = true, working = false, gaze = true }: {
  name: string; color: AvatarColor; glasses: AvatarGlasses; size?: number;
  animated?: boolean; working?: boolean; gaze?: boolean;
}) {
  const avatarRef = useAvatarPointerGaze(gaze, animated, 1.3);
  return <AvatarArt name={name} color={color} glasses={glasses} size={size} animated={animated} working={working} svgRef={avatarRef} />;
}

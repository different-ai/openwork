/** @jsxImportSource react */
import { MarbleAvatar } from "./marble-avatar";

type ExtensionMeshAvatarProps = {
  name: string;
  category?: string;
  className?: string;
  square?: boolean;
};

export function ExtensionMeshAvatar({ name, category = "fallback", className, square = true }: ExtensionMeshAvatarProps) {
  return (
    <MarbleAvatar seed={`${category}:${name}`} square={square} className={className} />
  );
}

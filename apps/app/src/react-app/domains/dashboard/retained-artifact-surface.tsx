import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ArtifactSurfaceVisibility = createContext(true);
export function useArtifactSurfaceActive() {
  return useContext(ArtifactSurfaceVisibility);
}

export function RetainedArtifactSurface({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  if (!active && !visited) return null;
  return (
    <ArtifactSurfaceVisibility.Provider value={active}>
      <div
        hidden={!active}
        inert={!active}
        aria-hidden={!active || undefined}
        className={active ? "h-full min-h-0 overflow-y-auto" : "hidden"}
        data-retained-artifacts-surface
      >
        {children}
      </div>
    </ArtifactSurfaceVisibility.Provider>
  );
}

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ArtifactSurfaceVisibility = createContext(true);
export function useArtifactSurfaceActive() {
  return useContext(ArtifactSurfaceVisibility);
}

/**
 * Keep the artifacts a member opened alive across page navigation, not a grid
 * of background Apps. The owner keys this component by verified identity and
 * deployment; a sign-out, scope change or rollout kill tears it down.
 */
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

/** One opened artifact on the page: only the selected one shows, and the rest keep their state. */
export function RetainedArtifact({ active, children }: { active: boolean; children: ReactNode }) {
  const surfaceActive = useArtifactSurfaceActive();
  return (
    <ArtifactSurfaceVisibility.Provider value={surfaceActive && active}>
      <div hidden={!active} inert={!active} aria-hidden={!active || undefined} data-retained-artifact={active ? "selected" : "kept"}>
        {children}
      </div>
    </ArtifactSurfaceVisibility.Provider>
  );
}

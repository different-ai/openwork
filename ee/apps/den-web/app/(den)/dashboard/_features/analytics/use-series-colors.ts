"use client";

import { useEffect, useMemo, useState } from "react";
import { assignSeriesColors } from "./series-colors";

export function useSeriesColors(ids: string[], scope: string) {
  const [assigned, setAssigned] = useState<{ scope: string; colors: ReadonlyMap<string, string> }>({ scope, colors: new Map() });
  const colors = useMemo(() => assignSeriesColors(ids, assigned.scope === scope ? assigned.colors : undefined), [ids, scope, assigned]);
  useEffect(() => {
    if (assigned.scope !== scope || assigned.colors !== colors) setAssigned({ scope, colors });
  }, [assigned, colors, scope]);
  return colors;
}

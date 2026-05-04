import * as React from "react";
import { t } from "@/i18n";

export function useTranslate() {
  const tr = React.useCallback((key: string) => t(key), []);
  const tx = React.useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params),
    [],
  );

  return React.useMemo(() => ({ tr, tx }), [tr, tx]);
}

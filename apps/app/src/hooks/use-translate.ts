import * as React from "react";
import { currentLocale, t } from "@/i18n";

export function useTranslate() {
  const tr = React.useCallback((key: string) => t(key, currentLocale()), []);
  const tx = React.useCallback(
    (key: string, params?: Record<string, string | number>) =>
      t(key, currentLocale(), params),
    [],
  );

  return React.useMemo(() => ({ tr, tx }), [tr, tx]);
}

import type { ReactNode } from "react";
import {
  ConsentBanner,
  ConsentDialog,
  ConsentManagerProvider,
} from "@c15t/react";

type CookieConsentProviderProps = {
  children: ReactNode;
  enabled?: boolean;
};

export function CookieConsentProvider({
  children,
  enabled = true,
}: CookieConsentProviderProps) {
  if (!enabled) return <>{children}</>;

  return (
    <ConsentManagerProvider
      options={{
        mode: "offline",
        consentCategories: [
          "necessary",
          "measurement",
          "marketing",
          "functionality",
        ],
      }}
    >
      <ConsentBanner />
      <ConsentDialog />
      {children}
    </ConsentManagerProvider>
  );
}

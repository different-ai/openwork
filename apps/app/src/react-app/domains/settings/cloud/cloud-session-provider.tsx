/** @jsxImportSource react */
import * as React from "react";

import {
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenClient,
  readDenSettings,
  type DenSettings,
  type DenOrgSummary,
  type DenUser,
} from "../../../../app/lib/den";
import { denSettingsChangedEvent } from "../../../../app/lib/den-session-events";

export type CloudActiveOrganization = Pick<DenOrgSummary, "id" | "name" | "role" | "slug">;

export function cloudSessionOrganizationFromSettings(
  settings: Pick<DenSettings, "activeOrgId" | "activeOrgName" | "activeOrgSlug">,
): CloudActiveOrganization | null {
  const id = settings.activeOrgId?.trim() ?? "";
  if (!id) return null;
  return {
    id,
    name: settings.activeOrgName?.trim() ?? "",
    role: "member",
    slug: settings.activeOrgSlug?.trim() ?? "",
  };
}

type CloudSessionContextValue = {
  client: DenClient;
  baseUrl: string;
  setBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  authToken: string;
  setAuthToken: React.Dispatch<React.SetStateAction<string>>;
  isSignedIn: boolean;
  setIsSignedIn: React.Dispatch<React.SetStateAction<boolean>>;
  user: DenUser | null;
  setUser: React.Dispatch<React.SetStateAction<DenUser | null>>;
  statusMessage: string | null;
  setStatusMessage: React.Dispatch<React.SetStateAction<string | null>>;
  activeOrganization: CloudActiveOrganization | null;
  setActiveOrganization: React.Dispatch<React.SetStateAction<CloudActiveOrganization | null>>;
  activeOrgName: string;
  hasActiveOrg: boolean;
};

const CloudSessionContext = React.createContext<CloudSessionContextValue | null>(null);

type CloudSessionProviderProps = {
  children: React.ReactNode;
};

export function CloudSessionProvider({ children }: CloudSessionProviderProps) {
  const initial = React.useMemo(() => readDenSettings(), []);

  const [baseUrl, setBaseUrl] = React.useState(() => initial.baseUrl || DEFAULT_DEN_BASE_URL);
  const [authToken, setAuthToken] = React.useState(initial.authToken?.trim() || "");
  const [isSignedIn, setIsSignedIn] = React.useState(false);
  const [user, setUser] = React.useState<DenUser | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [activeOrganization, setActiveOrganization] =
    React.useState<CloudActiveOrganization | null>(() => cloudSessionOrganizationFromSettings(initial));
  const activeOrgName = activeOrganization?.name ?? "";
  const hasActiveOrg = Boolean(activeOrganization);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSettingsChanged = () => {
      const settings = readDenSettings();
      setBaseUrl(settings.baseUrl || DEFAULT_DEN_BASE_URL);
      setAuthToken(settings.authToken?.trim() || "");
      setActiveOrganization(cloudSessionOrganizationFromSettings(settings));
    };

    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  const client = React.useMemo(
    () => createDenClient({ baseUrl, token: authToken }),
    [authToken, baseUrl],
  );

  const value = React.useMemo<CloudSessionContextValue>(
    () => ({
      client,
      baseUrl,
      setBaseUrl,
      authToken,
      setAuthToken,
      isSignedIn,
      setIsSignedIn,
      user,
      setUser,
      statusMessage,
      setStatusMessage,
      activeOrganization,
      setActiveOrganization,
      activeOrgName,
      hasActiveOrg,
    }),
    [activeOrgName, activeOrganization, authToken, baseUrl, client, hasActiveOrg, isSignedIn, statusMessage, user],
  );

  return <CloudSessionContext.Provider value={value}>{children}</CloudSessionContext.Provider>;
}

export function useCloudSession() {
  const context = React.use(CloudSessionContext);

  if (!context) {
    throw new Error("useCloudSession must be used within a CloudSessionProvider");
  }

  return context;
}

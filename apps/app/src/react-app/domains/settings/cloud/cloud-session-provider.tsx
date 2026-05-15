/** @jsxImportSource react */
import * as React from "react";

import {
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenClient,
  readDenSettings,
  type DenOrgSummary,
  type DenUser,
} from "../../../../app/lib/den";

type CloudActiveOrganization = Pick<DenOrgSummary, "id" | "name" | "slug">;

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
    React.useState<CloudActiveOrganization | null>(() => {
      const id = initial.activeOrgId?.trim();
      if (!id) return null;

      return {
        id,
        name: initial.activeOrgName?.trim() || "",
        slug: initial.activeOrgSlug?.trim() || "",
      };
    });
  const activeOrgName = activeOrganization?.name ?? "";
  const hasActiveOrg = Boolean(activeOrganization);

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

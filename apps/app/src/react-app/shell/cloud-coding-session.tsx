import { CLOUD_CODING_CONNECTION_ID } from "@openwork/types/den/cloud-coding";

import type { DenClient } from "@/app/lib/den";
import type { ResolveConnectionCard } from "@/components/chat/connection-card";
import { GITHUB_SERVICE_MARK } from "@/components/ui/service-mark";
import { t } from "@/i18n";
import { authenticateCloudCodingGitHub } from "@/react-app/domains/cloud-coding/authenticate-github";
import { CloudCodingConnectionCard } from "@/react-app/domains/cloud-coding/cloud-coding-connection-card";
import type { ConnectionAuthentication } from "@/react-app/kernel/connection-authentication";

type CloudCodingConnectionScope = {
  client: Pick<DenClient, "getCloudCodingOverview" | "requestCloudCodingAdmin">;
  denBaseUrl: string;
  organizationId: string;
  principal: string;
};

export function cloudCodingSessionConnections(scope: CloudCodingConnectionScope | null, enabled: boolean | undefined) {
  const resolveCard: ResolveConnectionCard = (connection) => {
    if (connection.connectionId !== CLOUD_CODING_CONNECTION_ID) return undefined;
    if (enabled === false || (enabled === undefined && connection.actor === "member")) return { hidden: true };
    const organizationBlocked = connection.state === "needs_connection" && connection.actor === "organization_admin"
      && connection.action?.surface === "openwork_organization_connections";
    return {
      iconUrl: GITHUB_SERVICE_MARK,
      allowMemberAction: scope !== null,
      renderBlocked: scope && organizationBlocked ? ({ fallback, dismiss }) => (
        <CloudCodingConnectionCard key={JSON.stringify([scope.denBaseUrl, scope.organizationId, scope.principal])}
          scope={scope} fallback={fallback} dismiss={dismiss} />
      ) : undefined,
    };
  };
  const authentication = new Map<string, ConnectionAuthentication>([[CLOUD_CODING_CONNECTION_ID, {
    enabled: scope !== null,
    authenticate: (input) => {
      if (!scope || scope.organizationId !== input.organizationId || scope.denBaseUrl !== input.baseUrl) {
        return Promise.reject(new Error(t("cloud_coding.link_changed")));
      }
      return authenticateCloudCodingGitHub(input);
    },
  }]]);
  return { resolveCard, authentication };
}

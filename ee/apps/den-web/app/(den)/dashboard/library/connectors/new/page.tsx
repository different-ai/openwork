import { Suspense } from "react";
import { ConnectorCatalogScreen } from "../../../_components/connector-catalog-screen";

export default function LibraryAddConnectorPage() {
  return (
    <Suspense fallback={null}>
      <ConnectorCatalogScreen mode="member" />
    </Suspense>
  );
}

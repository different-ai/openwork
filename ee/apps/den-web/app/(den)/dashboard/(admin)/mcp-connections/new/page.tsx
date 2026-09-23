import { Suspense } from "react";
import { ConnectorCatalogScreen } from "../../../_components/connector-catalog-screen";

export default function AddConnectorPage() {
  return (
    <Suspense fallback={null}>
      <ConnectorCatalogScreen mode="admin" />
    </Suspense>
  );
}

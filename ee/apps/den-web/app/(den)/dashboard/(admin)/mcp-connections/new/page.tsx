import { ConnectorCatalogScreen } from "../../../_components/connector-catalog-screen";
import { ConnectorsAddIntro } from "../../../_components/connectors-add-intro";

export default function AddConnectorPage() {
  return (
    <>
      <ConnectorsAddIntro />
      <ConnectorCatalogScreen mode="admin" />
    </>
  );
}

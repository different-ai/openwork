import { useMemo, useState } from "react";
import { Plug } from "lucide-react";

import { composerConnectorLogoUrls } from "./composer-connector-logos";

/** The logo mark of a connector, falling back to a plug while none loads. */
export function ConnectorLogo(props: { connector: { name: string; serviceUrl?: string } }) {
  const urls = useMemo(
    () => composerConnectorLogoUrls({ name: props.connector.name, serviceUrl: props.connector.serviceUrl }),
    [props.connector.name, props.connector.serviceUrl],
  );
  const [failed, setFailed] = useState(0);
  const url = urls[failed];
  if (!url) return <Plug className="size-4 text-gray-10" aria-hidden="true" />;
  return (
    <img
      src={url}
      alt=""
      className="size-4 object-contain"
      decoding="async"
      onError={() => setFailed((current) => current + 1)}
    />
  );
}

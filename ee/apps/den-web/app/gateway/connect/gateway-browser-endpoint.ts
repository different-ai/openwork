import { denApiEndpoint } from "../../(den)/_lib/den-api-origin";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";

export async function gatewayBrowserEndpoint(path: string) {
  await getRuntimeConfig();
  return denApiEndpoint(path);
}

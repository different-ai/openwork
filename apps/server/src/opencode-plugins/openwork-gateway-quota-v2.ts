import { gatewayBase, isGatewayQuotaResponse, record } from "../gateway-quota.js";

type HttpResponse = {
  model: { providerID: string };
  request: Request;
  response: Response;
};

type Context = {
  options: Record<string, unknown>;
  provider?: {
    get: (input: { providerID: string }) => Promise<{ settings?: { baseURL?: unknown } } | undefined>;
  };
  session: {
    hook: (
      name: "http.response",
      callback: (event: HttpResponse) => Promise<void>,
      options?: { providerID: string },
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
};

async function preventQuotaRetry(event: HttpResponse, base: URL): Promise<void> {
  if (!await isGatewayQuotaResponse(base, new URL(event.request.url), event.response)) return;
  const response = event.response;
  const headers = new Headers(response.headers);
  headers.set("x-should-retry", "false");
  event.response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  id: "openwork.gateway-quota",
  setup: async (context: Context) => {
    const providers = record(context.options.providers) ? context.options.providers : {};
    const registrations: { dispose: () => Promise<void> }[] = [];
    for (const [id, baseURL] of Object.entries(providers)) {
      const base = gatewayBase(id, baseURL);
      if (!base) continue;
      registrations.push(await context.session.hook("http.response", async (event) => {
        if (event.model.providerID === id) await preventQuotaRetry(event, base);
      }, { providerID: id }));
    }
    if (context.options.liveProviders === true && context.provider) {
      const provider = context.provider;
      // The live source changes independently of watched config. Resolve its
      // current native settings at request time instead of retaining another
      // inventory copy or reintroducing static gateway config rows.
      registrations.push(await context.session.hook("http.response", async event => {
        const id = event.model.providerID;
        if (!/^ipr_[a-z0-9]+$/.test(id) || Object.hasOwn(providers, id)) return;
        const current = await provider.get({ providerID: id }).catch(() => undefined);
        const base = gatewayBase(id, current?.settings?.baseURL);
        if (base) await preventQuotaRetry(event, base);
      }));
    }
    return async () => {
      for (const registration of registrations) await registration.dispose();
    };
  },
};

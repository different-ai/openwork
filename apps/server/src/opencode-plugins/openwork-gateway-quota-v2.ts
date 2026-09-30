import { gatewayBase, isGatewayQuotaResponse, record } from "../gateway-quota.js";

type HttpResponse = {
  model: { providerID: string };
  request: Request;
  response: Response;
};

type Context = {
  options: Record<string, unknown>;
  session: {
    hook: (
      name: "http.response",
      callback: (event: HttpResponse) => Promise<void>,
      options: { providerID: string },
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
};

export default {
  id: "openwork.gateway-quota",
  setup: async (context: Context) => {
    const providers = record(context.options.providers) ? context.options.providers : {};
    const registrations: { dispose: () => Promise<void> }[] = [];
    for (const [id, baseURL] of Object.entries(providers)) {
      const base = gatewayBase(id, baseURL);
      if (!base) continue;
      registrations.push(await context.session.hook("http.response", async (event) => {
        if (event.model.providerID !== id
          || !await isGatewayQuotaResponse(base, new URL(event.request.url), event.response)) return;
        const response = event.response;
        const headers = new Headers(response.headers);
        headers.set("x-should-retry", "false");
        event.response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }, { providerID: id }));
    }
    return async () => {
      for (const registration of registrations) await registration.dispose();
    };
  },
};

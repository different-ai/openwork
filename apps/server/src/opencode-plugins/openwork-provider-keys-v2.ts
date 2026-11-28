export const CREDENTIAL_FREE_INTEGRATION_ID = "openwork-provider-key";

type Provider = { integrationID?: string; activation?: string };
type ProviderEditor = { update(id: string, callback: (provider: Provider) => void): void };
type Context = {
  options: { providers?: string[] };
  provider: { transform(callback: (editor: ProviderEditor) => void): Promise<{ dispose(): Promise<void> }> };
};

export default {
  id: "openwork.provider-keys",
  async setup(context: Context) {
    const registration = await context.provider.transform(editor => {
      for (const id of context.options.providers ?? []) {
        editor.update(id, provider => {
          provider.integrationID = CREDENTIAL_FREE_INTEGRATION_ID;
          provider.activation = "enabled";
        });
      }
    });
    return () => registration.dispose();
  },
};

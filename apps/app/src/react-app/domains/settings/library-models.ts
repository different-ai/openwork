import { gatewayMemberSignInMethod } from "@openwork/types/den/inference";

export type LibraryModelState = "ready" | "needs_signin" | "blocked";

export type LibraryModelProvider = {
  id: string;
  name: string;
  providerKey: string | null;
  state: LibraryModelState;
  modelNames: string[];
  modelCount: number;
  signInKey: string | null;
};

export type LibraryModelSignInBrand = "google" | "aws" | "microsoft" | "account";

export function librarySignInBrand(provider: Pick<LibraryModelProvider, "providerKey">): LibraryModelSignInBrand {
  const method = provider.providerKey ? gatewayMemberSignInMethod(provider.providerKey) : null;
  return method === "google" ? "google" : method === "aws_sso" ? "aws" : method === "microsoft" ? "microsoft" : "account";
}

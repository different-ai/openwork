import { useDenAuth } from "@/react-app/kernel/den-auth-context"
import { cloudSessionDraftScope } from "../sync/draft-store"

export function useRemoteHelperScope(): string | null {
  return cloudSessionDraftScope(useDenAuth().verifiedIdentity)
}

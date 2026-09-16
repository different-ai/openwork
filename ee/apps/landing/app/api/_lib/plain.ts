import { PlainGraphQLClient, type CreateThreadInput, type MutationError, type UpsertCustomerInput } from "@team-plain/graphql";
import { parse } from "graphql";

type MutationResult = { error?: Pick<MutationError, "code"> | null };
type CustomerResult = MutationResult & { customer?: { id: string } | null };
type ThreadResult = MutationResult & { thread?: { id: string } | null };

// Generated SDK mutations expand related resources, requiring permissions beyond
// this form's customer/thread scopes. Select only the IDs and error codes we use.
const upsertCustomerDocument = parse(`
  mutation LandingUpsertCustomer($input: UpsertCustomerInput!) {
    upsertCustomer(input: $input) {
      customer { id }
      error { code }
    }
  }
`);

const createThreadDocument = parse(`
  mutation LandingCreateThread($input: CreateThreadInput!) {
    createThread(input: $input) {
      thread { id }
      error { code }
    }
  }
`);

export function createPlainFormClient(apiKey: string) {
  const client = new PlainGraphQLClient({ apiKey });
  return {
    async upsertCustomer(input: UpsertCustomerInput) {
      const result = await client.request<
        { upsertCustomer: CustomerResult },
        { input: UpsertCustomerInput }
      >(upsertCustomerDocument, { input });
      return result.upsertCustomer;
    },
    async createThread(input: CreateThreadInput) {
      const result = await client.request<
        { createThread: ThreadResult },
        { input: CreateThreadInput }
      >(createThreadDocument, { input });
      return result.createThread;
    },
  };
}

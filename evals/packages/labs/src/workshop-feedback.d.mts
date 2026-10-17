export interface PlainThread {
  id: string;
  createdAt: string;
  input: {
    customerIdentifier: { customerId: string };
    title: string;
    components: { componentPlainText: { plainText: string } }[];
    threadFields: { key: string; type: "STRING"; stringValue: string }[];
  };
}
export interface PlainState {
  customers: { id: string; email: string; input: Record<string, unknown> }[];
  threads: PlainThread[];
  audit: { sequence: number; at: number; operation: string; input: Record<string, unknown>; result: Record<string, unknown> }[];
}
export function startPlainWitness(options: { directory: string; token: string }): Promise<{
  origin: string;
  read(): Promise<PlainState>;
  [Symbol.asyncDispose](): Promise<void>;
}>;

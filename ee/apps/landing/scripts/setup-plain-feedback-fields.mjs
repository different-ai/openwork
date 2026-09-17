import { PlainGraphQLClient } from "@team-plain/graphql";
import { parse } from "graphql";
import { pathToFileURL } from "node:url";
import { plainFeedbackFieldSchemas } from "../lib/plain-feedback-fields.ts";

const listSchemas = parse(`
  query LandingFeedbackFieldSchemas($after: String) {
    threadFieldSchemas(first: 50, after: $after) {
      edges { node { key type order } }
      pageInfo { hasNextPage endCursor }
    }
  }
`);
const createSchema = parse(`
  mutation LandingCreateFeedbackFieldSchema($input: CreateThreadFieldSchemaInput!) {
    createThreadFieldSchema(input: $input) {
      threadFieldSchema { key }
      error { code }
    }
  }
`);

async function main() {
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify(plainFeedbackFieldSchemas, null, 2));
    console.log("Preview only. To create missing schemas, set PLAIN_SETUP_API_KEY and run again with --apply.");
    return;
  }

  const apiKey = process.env.PLAIN_SETUP_API_KEY?.trim();
  if (!apiKey) throw new Error("Set PLAIN_SETUP_API_KEY with threadFieldSchema:read and threadFieldSchema:create permissions.");
  await setupPlainFeedbackFields(new PlainGraphQLClient({ apiKey }));
}

export async function setupPlainFeedbackFields(client) {
  const existing = new Map();
  let after;
  let nextOrder = 0;
  do {
    const result = await client.request(listSchemas, { after });
    const connection = result.threadFieldSchemas;
    for (const { node } of connection.edges) {
      existing.set(node.key, node.type);
      nextOrder = Math.max(nextOrder, node.order + 1);
    }
    if (!connection.pageInfo.hasNextPage) break;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || nextCursor === after) throw new Error("Plain returned an invalid pagination cursor.");
    after = nextCursor;
  } while (true);

  // Check all existing types before making changes. Never overwrite workspace schemas.
  for (const field of plainFeedbackFieldSchemas) {
    if (existing.has(field.key) && existing.get(field.key) !== field.type) {
      throw new Error(`Schema ${field.key} must have type ${field.type}; no schemas were changed.`);
    }
  }

  for (const field of plainFeedbackFieldSchemas) {
    if (existing.has(field.key)) {
      console.log(`Already configured: ${field.key}`);
      continue;
    }
    const result = await client.request(createSchema, { input: { ...field, order: nextOrder++ } });
    if (result.createThreadFieldSchema.error || !result.createThreadFieldSchema.threadFieldSchema?.key) {
      throw new Error(`Could not create ${field.key}: ${result.createThreadFieldSchema.error?.code ?? "missing_result"}. Rerunning will skip completed schemas.`);
    }
    console.log(`Created: ${field.key}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // SDK transport error messages may contain private response details.
    console.error(error?.constructor === Error ? error.message : `Plain setup failed: ${error?.name ?? "UnknownError"}`);
    process.exitCode = 1;
  });
}

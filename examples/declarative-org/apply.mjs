#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Usage: DEN_API_URL=... DEN_API_KEY=... node apply.mjs organization.json [--delete]
// One writer per manifest. Only --delete removes resources; missing entries do
// not implicitly delete resources that somebody else may own.
const [filename, mode] = process.argv.slice(2);
if (!filename || (mode && mode !== '--delete')) throw new Error('Usage: node apply.mjs organization.json [--delete]');
const api = process.env.DEN_API_URL;
const apiKey = process.env.DEN_API_KEY;
if (!api || !apiKey) throw new Error('Set DEN_API_URL and DEN_API_KEY.');
const endpoint = new URL(api);
if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Use HTTPS for a remote Den.');

function expand(value) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    if (!process.env[name]) throw new Error(`Missing environment variable ${name}`);
    return process.env[name];
  });
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  return value;
}
const raw = JSON.parse(await readFile(filename, 'utf8'));
// Deletion needs only keys and must work after credentials have been revoked.
const config = mode === '--delete' ? raw : expand(raw);
if (config.version !== 1) throw new Error('Unsupported manifest version.');
const resources = [
  ['teams', 'teams', 'team'],
  ['llmProviders', 'llm-providers', 'llmProvider'],
  ['mcpConnections', 'mcp-connections', null],
  ['desktopPolicies', 'desktop-policies', 'desktopPolicy'],
  ['marketplaces', 'marketplaces', 'item'],
];
for (const section of Object.keys(config)) {
  if (section !== 'version' && !resources.some(([name]) => name === section)) throw new Error(`Unknown manifest section ${section}`);
}
for (const [section] of resources) {
  const entries = config[section] ?? {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${section} must be an object keyed by stable identity.`);
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key)) throw new Error(`Invalid key ${section}.${key}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid resource ${section}.${key}`);
    if (value.externalKey !== undefined) throw new Error(`Put the identity in the object key, not ${section}.${key}.externalKey`);
    if (value.teams !== undefined && (!Array.isArray(value.teams) || value.teams.some((name) => !Object.hasOwn(config.teams ?? {}, name)))) throw new Error(`Unknown team reference in ${section}.${key}`);
    if (value.teams !== undefined && value.teamIds !== undefined) throw new Error(`Use teams or teamIds, not both, in ${section}.${key}`);
    if (value.teams !== undefined && !['llmProviders', 'desktopPolicies'].includes(section)) throw new Error(`Team references are supported on providers and policies; use the resource API for ${section}.${key} access grants.`);
  }
}
async function write(resource, key, body) {
  const path = `/v1/${resource}/by-key/${key}`;
  // Bounded retries make a lost response safe. Never log bodies or raw server
  // errors: those may contain credentials supplied in a manifest.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(new URL(path, endpoint), {
        method: mode === '--delete' ? 'DELETE' : 'PUT',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(mode === '--delete' ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
    } catch {
      if (attempt === 2) throw new Error(`Network failure applying ${resource}/${key}; rerun safely after checking connectivity.`);
    }
    if (response?.ok) {
      console.log(`${mode === '--delete' ? 'deleted' : response.status === 201 ? 'created' : 'updated'} ${resource}/${key}`);
      return response.json();
    }
    if (response && response.status !== 409 && response.status !== 429 && response.status < 500) throw new Error(`${resource}/${key}: HTTP ${response.status}. Check the documented permissions and request fields.`);
    if (attempt === 2) throw new Error(`${resource}/${key}: HTTP ${response?.status}. Check for a name conflict or a concurrent configuration writer.`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}
const teamIds = new Map();
for (const [section, resource, envelope] of mode === '--delete' ? [...resources].reverse() : resources) {
  for (const [key, input] of Object.entries(config[section] ?? {})) {
    const { teams, ...body } = input;
    if (teams && mode !== '--delete') body.teamIds = teams.map((name) => teamIds.get(name));
    const result = await write(resource, key, body);
    if (section === 'teams' && mode !== '--delete') {
      const id = result[envelope]?.id;
      if (typeof id !== 'string') throw new Error(`Missing team ID in response for ${key}`);
      teamIds.set(key, id);
    }
  }
}

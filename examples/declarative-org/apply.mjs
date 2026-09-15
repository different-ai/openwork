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
function validAccessIds(ids, prefix) {
  const pattern = new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`);
  return ids === undefined || (Array.isArray(ids) && ids.length <= 200 && ids.every((id) => typeof id === 'string' && pattern.test(id.trim())));
}
const raw = JSON.parse(await readFile(filename, 'utf8'));
// Deletion needs only keys and must work after credentials have been revoked.
const config = mode === '--delete' ? raw : expand(raw);
if (config.version !== 1) throw new Error('Unsupported manifest version.');
const resources = [
  ['teams', 'teams', 'team'],
  ['llmProviders', 'llm-providers', 'llmProvider'],
  ['mcpConnections', 'mcp-connections', null], // MCP responses are bare, not wrapped.
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
    if (mode === '--delete') continue;
    if (section === 'mcpConnections') {
      const access = value.access;
      if (!access || typeof access !== 'object' || Array.isArray(access)
        || Object.keys(access).some((field) => !['orgWide', 'memberIds', 'teamIds'].includes(field))
        || (access.orgWide !== undefined && typeof access.orgWide !== 'boolean')
        || !validAccessIds(access.memberIds, 'om') || !validAccessIds(access.teamIds, 'tem')) {
        throw new Error(`Explicit valid MCP access is required in ${section}.${key}`);
      }
      if (value.teams !== undefined && access.teamIds !== undefined) throw new Error(`Use teams or access.teamIds, not both, in ${section}.${key}`);
    }
    if (value.teams !== undefined && (!Array.isArray(value.teams) || value.teams.some((name) => typeof name !== 'string' || !Object.hasOwn(config.teams ?? {}, name)) || (section === 'mcpConnections' && value.teams.length > 200))) throw new Error(`Unknown team reference in ${section}.${key}`);
    if (value.teams !== undefined && value.teamIds !== undefined) throw new Error(`Use teams or teamIds, not both, in ${section}.${key}`);
    if (value.teams !== undefined && !['llmProviders', 'desktopPolicies', 'mcpConnections'].includes(section)) throw new Error(`Team references are supported on providers, policies, and MCP connections; use the resource API for ${section}.${key} access grants.`);
  }
}
async function mcpRequest(path, method = 'GET', body, updatedAt) {
  try {
    return await fetch(new URL(path, endpoint), {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(updatedAt ? { 'If-Match': updatedAt } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    throw new Error('MCP network failure; outcome uncertain. Check the connection state before applying again.');
  }
}
function mcpFailure(response, key) {
  if (response.status === 502) throw new Error(`mcp-connections/${key}: HTTP 502. The proposed connection could not be validated. Check the upstream server and authentication before applying again.`);
  throw new Error(`mcp-connections/${key}: HTTP ${response.status}. Check permissions, request fields, or a concurrent configuration writer before applying again.`);
}
async function mcpJson(response, key) {
  if (!response.ok) mcpFailure(response, key);
  try {
    return await response.json();
  } catch {
    throw new Error(`mcp-connections/${key}: Invalid JSON response; check the connection state before applying again.`);
  }
}
// No MCP GET-by-key exists. Keyed PUT uses If-Match; only PUT-by-ID requires
// expectedUpdatedAt in its body. Never wrap the MCP request body in an envelope.
async function mcpTimestamp(key) {
  const listing = await mcpJson(await mcpRequest('/v1/mcp-connections?scope=manageable'), key);
  if (!Array.isArray(listing?.connections)) throw new Error(`mcp-connections/${key}: Missing manageable connections list.`);
  const matches = listing.connections.filter((connection) => connection?.externalKey === key);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1 || typeof matches[0].id !== 'string') throw new Error(`mcp-connections/${key}: Invalid manageable connection identity.`);
  const connection = await mcpJson(await mcpRequest(`/v1/mcp-connections/${encodeURIComponent(matches[0].id)}`), key);
  if (connection?.id !== matches[0].id || connection.externalKey !== key || typeof connection.updatedAt !== 'string' || !Number.isFinite(Date.parse(connection.updatedAt))) throw new Error(`mcp-connections/${key}: Missing current connection timestamp or identity.`);
  return connection.updatedAt;
}
async function writeMcp(key, body) {
  const path = `/v1/mcp-connections/by-key/${key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const deleting = mode === '--delete';
    const updatedAt = deleting ? undefined : await mcpTimestamp(key);
    const response = await mcpRequest(path, deleting ? 'DELETE' : 'PUT', deleting ? undefined : body, updatedAt);
    if (!deleting && response.status === 409 && attempt === 0) {
      await response.body?.cancel();
      continue;
    }
    const result = await mcpJson(response, key);
    console.log(`${deleting ? 'deleted' : response.status === 201 ? 'created' : 'updated'} mcp-connections/${key}`);
    return result;
  }
}
async function write(resource, key, body) {
  if (resource === 'mcp-connections') return writeMcp(key, body);
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
    if (teams && mode !== '--delete') {
      const resolved = teams.map((name) => teamIds.get(name));
      if (section === 'mcpConnections') body.access = { ...body.access, teamIds: resolved };
      else body.teamIds = resolved;
    }
    const result = await write(resource, key, body);
    const item = envelope === null ? result : result[envelope];
    if (section === 'teams' && mode !== '--delete') {
      const id = item?.id;
      if (typeof id !== 'string') throw new Error(`Missing team ID in response for ${key}`);
      teamIds.set(key, id);
    }
  }
}

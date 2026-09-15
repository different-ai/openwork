import importlib
import json
import os
import sys

sys.dont_write_bytecode = True
client = importlib.import_module('mcp-put-release-client')
request = client.request
ROOT = client.ROOT
MCP_BASE = os.environ['PROOF_MCP_BASE']
public = {'name': 'Release proof public', 'url': MCP_BASE + '/public', 'authType': 'none', 'credentialMode': 'shared', 'exposeDirectly': False, 'access': {'orgWide': True, 'memberIds': [], 'teamIds': []}}
keyed = '/v1/mcp-connections/by-key/rs-proof-1'


def preflight():
    request('setup-foreign-org-attempt', 'POST', '/v1/org', {'name': 'Release Proof Foreign'}, auth='session')
    request('ssrf-http-witness-rejected', 'PUT', '/v1/mcp-connections/by-key/rs-proof-local', {**public, 'url': 'http://mcp-put-proof-release-witness:8080/public'})
    request('witness-unauthenticated-control', 'POST', '/bearer', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'release_credential_witness', 'arguments': {'nonce': 'unauthenticated-control'}}}, auth='none', base=MCP_BASE)
    request('witness-public-preflight', 'POST', '/public', {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'release-proof', 'version': '1'}}}, auth='none', base=MCP_BASE)


def proof():
    state = client.load()
    status, created = request('case1-create', 'PUT', keyed, public)
    if status != 201:
        print('Create did not return 201; no automatic retry. Inspect receipt.')
        return
    state['connectionId'] = created['id']
    client.save(state)
    item = '/v1/mcp-connections/' + created['id']
    request('case2-identical', 'PUT', keyed, public)
    request('case2-list', 'GET', '/v1/mcp-connections?scope=manageable')
    status, team = request('case3-create-team', 'PUT', '/v1/teams/by-key/rs-proof-team', {'name': 'Release Proof Team', 'memberIds': []})
    if status == 201:
        team_id = team['team']['id']
        scoped = {**public, 'name': 'Release proof team scoped', 'access': {'orgWide': False, 'memberIds': [], 'teamIds': [team_id]}}
        request('case3-rename-team-access', 'PUT', keyed, scoped)
        request('case3-read-team-access', 'GET', item)
        omitted = {k: v for k, v in scoped.items() if k != 'access'}
        omitted['name'] = 'Release proof omitted access'
        request('case3-omit-access', 'PUT', keyed, omitted)
        request('case3-read-widened-access', 'GET', item)
    request('case4-duplicate-post', 'POST', '/v1/mcp-connections', {**public, 'externalKey': 'rs-proof-1'})
    status, row = request('case5-get-id', 'GET', item)
    if status == 200:
        update = client.jq('{expectedUpdatedAt:.updatedAt,name:"Release proof ID rename",url,authType,credentialMode,exposeDirectly,access}', row)
        request('case5-update-id', 'PUT', item, update)
        request('case5-stale-update-id', 'PUT', item, {**update, 'name': 'Release proof stale rejected'})
        request('case5-read-after-stale', 'GET', item)
    secret = dict(line.split('=', 1) for line in (ROOT / 'witness.env').read_text().splitlines())['WITNESS_SECRET']
    bearer = {**public, 'name': 'Release proof bearer', 'url': MCP_BASE + '/bearer', 'authType': 'apikey', 'apiKey': secret}
    status, secured = request('case6-secret-create', 'PUT', '/v1/mcp-connections/by-key/rs-proof-auth', bearer)
    if status == 201:
        state['securedId'] = secured['id']
        client.save(state)
        secure_item = '/v1/mcp-connections/' + secured['id']
        request('case6-secret-read', 'GET', secure_item)
        request('case6-call-before', 'POST', secure_item + '/tools/call', {'toolName': 'release_credential_witness', 'arguments': {'nonce': 'before-secret-omission'}})
        omit = {k: v for k, v in bearer.items() if k != 'apiKey'}
        omit['name'] = 'Release proof bearer retained'
        request('case6-omit-secret', 'PUT', '/v1/mcp-connections/by-key/rs-proof-auth', omit)
        request('case6-secret-read-after', 'GET', secure_item)
        request('case6-call-after', 'POST', secure_item + '/tools/call', {'toolName': 'release_credential_witness', 'arguments': {'nonce': 'after-secret-omission'}})
    request('case7-delete-key', 'DELETE', keyed)
    request('case7-deleted-get', 'GET', item)
    status, recreated = request('case7-recreate', 'PUT', keyed, public)
    if status == 201:
        state['recreatedId'] = recreated['id']
        client.save(state)
    request('case8-no-key-put', 'PUT', '/v1/mcp-connections/by-key/rs-proof-unauthorized', public, auth='none')
    request('case8-no-key-get', 'GET', '/v1/mcp-connections/' + state.get('recreatedId', created['id']), auth='none')
    request('case8-list-after-no-key', 'GET', '/v1/mcp-connections?scope=manageable')


def cleanup():
    for key in ['rs-proof-1', 'rs-proof-auth', 'rs-proof-local', 'rs-proof-unauthorized', 'platform-tools']:
        request('cleanup-' + key, 'DELETE', '/v1/mcp-connections/by-key/' + key)
    request('cleanup-team', 'DELETE', '/v1/teams/by-key/rs-proof-team')
    request('cleanup-list', 'GET', '/v1/mcp-connections?scope=manageable')


if __name__ == '__main__':
    {'preflight': preflight, 'proof': proof, 'cleanup': cleanup}[sys.argv[1]]()

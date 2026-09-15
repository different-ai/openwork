import hashlib
import importlib
import json
import os
import pathlib
import secrets
import subprocess
import sys

sys.dont_write_bytecode = True
os.environ.setdefault('DEN_API_URL', 'http://localhost:18789')
os.environ.setdefault('PROOF_WEB_ORIGIN', 'http://localhost:13006')
client = importlib.import_module('mcp-put-release-client')
ROOT = client.ROOT
request = client.request
PROJECT = 'mcp-put-proof-release-tenant'
ORIGINAL_SHA = 'c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc'
ORIGINAL = pathlib.Path('reports/mcp-put-by-key-transcript-2026-09-14.json')


def original_unchanged():
    if hashlib.sha256(ORIGINAL.read_bytes()).hexdigest() != ORIGINAL_SHA:
        raise RuntimeError('Original release transcript changed; stop')


def prepare():
    original_unchanged()
    if (ROOT / 'release.env').exists() or client.STATE.exists():
        raise RuntimeError('Refusing to overwrite private tenant state')
    env = {'OPENWORK_AUTH_SECRET': secrets.token_hex(32), 'OPENWORK_DB_ENCRYPTION_KEY': secrets.token_hex(32), 'OPENWORK_API_PORT': '18789', 'OPENWORK_WEB_PORT': '13006', 'OPENWORK_ALLOW_SIGNUP': 'true', 'OPENWORK_OWNER_EMAILS': '', 'OPENWORK_SETUP_CODE': ''}
    (ROOT / 'release.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items()))
    (ROOT / 'witness.env').write_text('WITNESS_SECRET=' + secrets.token_urlsafe(32) + '\n')
    client.save({'passwordA': 'Aa1!' + secrets.token_hex(14), 'passwordB': 'Bb2!' + secrets.token_hex(14), 'invalidKey': 'den_' + secrets.token_hex(32)})
    print('Prepared isolated tenant environment and directly compliant 32-character passwords.')


def require(status, expected):
    if status != expected:
        raise RuntimeError(f'Observed HTTP {status}, expected {expected}; inspect private receipt, no automatic retry')


def bootstrap():
    for tenant in ['A', 'B']:
        state = client.load()
        status, payload = request(f'tenant-{tenant}-signup', 'POST', '/api/auth/sign-up/email', {'email': f'release-tenant-{tenant.lower()}@example.com', 'name': f'Release Tenant {tenant}', 'password': state['password' + tenant]}, auth='none')
        require(status, 200)
        state['session' + tenant] = payload['token']
        state['session'] = payload['token']
        state['user' + tenant] = payload['user']['id']
        client.save(state)
        status, payload = request(f'tenant-{tenant}-create-org', 'POST', '/v1/org', {'name': f'Release Tenant {tenant}'}, auth='session')
        require(status, 201)
        state['org' + tenant] = payload['organization']['id']
        client.save(state)
        status, payload = request(f'tenant-{tenant}-read-org', 'GET', '/v1/org', auth='session', org=state['org' + tenant])
        require(status, 200)
        status, payload = request(f'tenant-{tenant}-issue-key', 'POST', '/v1/api-keys', {'name': f'Release Tenant {tenant} proof'}, auth='session', org=state['org' + tenant])
        require(status, 201)
        state['key' + tenant] = payload['key']
        state['keyId' + tenant] = payload['apiKey']['id']
        client.save(state)
    if state['userA'] == state['userB'] or state['orgA'] == state['orgB'] or state['keyA'] == state['keyB']:
        raise RuntimeError('Tenant bootstrap failed to create different users, organizations, and keys')
    print('Two distinct authenticated users, organizations, and organization API keys provisioned.')


def proof():
    original_unchanged()
    state = client.load()
    body = {'name': 'Tenant A source', 'url': os.environ['PROOF_MCP_BASE'] + '/public', 'authType': 'none', 'credentialMode': 'shared', 'exposeDirectly': False, 'access': {'orgWide': True, 'memberIds': [], 'teamIds': []}}
    keyed = '/v1/mcp-connections/by-key/rs-proof-tenant'
    status, source = request('tenant-source-create', 'PUT', keyed, body, auth='keyA')
    require(status, 201)
    state['sourceId'] = source['id']
    client.save(state)
    item = '/v1/mcp-connections/' + source['id']
    update = {**body, 'name': 'Foreign edit must not persist', 'expectedUpdatedAt': source['updatedAt']}
    for prefix, org in [('foreign', None), ('spoofed', state['orgA'])]:
        for method in ['GET', 'PUT', 'DELETE']:
            request(f'tenant-{prefix}-{method.lower()}', method, item, update if method == 'PUT' else None, auth='keyB', org=org)
        request(f'tenant-source-after-{prefix}', 'GET', item, auth='keyA')
    request('tenant-B-list-before-own-create', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyB')
    status, own = request('tenant-own-same-key-create', 'PUT', keyed, {**body, 'name': 'Tenant B own'}, auth='keyB')
    require(status, 201)
    state['ownId'] = own['id']
    client.save(state)
    request('tenant-A-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyA')
    request('tenant-B-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyB')
    request('tenant-B-spoofed-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyB', org=state['orgA'])
    request('tenant-source-owner-cannot-read-B', 'GET', '/v1/mcp-connections/' + own['id'], auth='keyA')
    for auth, prefix in [('none', 'missing-key'), ('invalidKey', 'invalid-key')]:
        request('tenant-' + prefix + '-get', 'GET', item, auth=auth)
        request('tenant-' + prefix + '-put', 'PUT', '/v1/mcp-connections/by-key/rs-proof-tenant-unauthorized', body, auth=auth)
    request('tenant-A-final-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyA')
    request('tenant-B-final-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='keyB')


def cleanup():
    for tenant in ['A', 'B']:
        request(f'tenant-cleanup-{tenant}', 'DELETE', '/v1/mcp-connections/by-key/rs-proof-tenant', auth='key' + tenant)
        request(f'tenant-cleanup-{tenant}-list', 'GET', '/v1/mcp-connections?scope=manageable', auth='key' + tenant)
    for tenant in ['A', 'B']:
        state = client.load()
        state['session'] = state['session' + tenant]
        client.save(state)
        request(f'tenant-cleanup-{tenant}-revoke-key', 'DELETE', '/v1/api-keys/' + state['keyId' + tenant], auth='session', org=state['org' + tenant])
        request(f'tenant-cleanup-{tenant}-revoked-key-control', 'GET', '/v1/mcp-connections?scope=manageable', auth='key' + tenant)


def export(destination):
    original_unchanged()
    if pathlib.Path(destination).exists():
        raise RuntimeError('Refusing to overwrite a saved tenant transcript')
    state = client.load()
    hidden = [v for k, v in state.items() if k.startswith(('password', 'session')) or k in ['keyA', 'keyB', 'invalidKey']]
    hidden += [line.split('=', 1)[1] for name in ['release.env', 'witness.env'] for line in (ROOT / name).read_text().splitlines() if any(word in line.split('=', 1)[0] for word in ['SECRET', 'KEY', 'CODE']) and line.split('=', 1)[1]]
    def clean(value):
        from mcp_proof_redaction import sanitize
        return sanitize(value, hidden)
    container = PROJECT + '-den-1'
    image_id = subprocess.check_output(['docker', 'inspect', container, '--format', '{{.Image}}'], text=True).strip()
    inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image_id, '--format', '{"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}},"architecture":{{json .Architecture}}}'], text=True))
    inspection['containerImage'] = subprocess.check_output(['docker', 'inspect', container, '--format', '{{.Config.Image}}'], text=True).strip()
    inspection['imageId'] = image_id
    environment = json.loads(subprocess.check_output(['docker', 'inspect', container, '--format', '{{json .Config.Env}}'], text=True))
    inspection['selectedEnvironment'] = {k: v for k, v in (line.split('=', 1) for line in environment) if k in ['DEN_ORG_MODE', 'DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP']}
    inspection['baseComposeSha256'] = hashlib.sha256(pathlib.Path('packaging/docker/docker-compose.eval.yml').read_bytes()).hexdigest()
    inspection['overrideSha256'] = hashlib.sha256(pathlib.Path('evals/fixtures/mcp-put-release-tenant.compose.yml').read_bytes()).hexdigest()
    receipts = [json.loads(path.read_text()) for path in sorted(ROOT.glob('request-*.json'))]
    output = {'schemaVersion': 1, 'kind': 'recorded-release-tenant-blackbox', 'originalTranscriptSha256': ORIGINAL_SHA, 'project': PROJECT, 'inspection': inspection, 'identities': {k: state[k] for k in ['userA', 'userB', 'orgA', 'orgB', 'sourceId', 'ownId']}, 'testkit': 'deferred_to_orchestrator', 'requests': clean(receipts)}
    serialized = json.dumps(output, indent=2) + '\n'
    if any(secret in serialized for secret in hidden):
        raise RuntimeError('Secret remains; refusing export')
    pathlib.Path(destination).write_text(serialized)
    print('Sanitized supplemental receipts exported:', len(receipts))


if __name__ == '__main__':
    if sys.argv[1] == 'export':
        export(sys.argv[2])
    else:
        {'prepare': prepare, 'bootstrap': bootstrap, 'proof': proof, 'cleanup': cleanup}[sys.argv[1]]()

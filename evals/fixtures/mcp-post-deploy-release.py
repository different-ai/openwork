import datetime
import hashlib
import importlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import urllib.parse

sys.dont_write_bytecode = True
client = importlib.import_module('mcp-put-release-client')
ROOT = client.ROOT


def prepare():
    if client.STATE.exists():
        raise RuntimeError('Private Lane3 state already exists')
    retained = json.loads((pathlib.Path(os.environ['PROOF_RETAINED_DIR']) / 'state.json').read_text())
    client.save({'key': retained['key'], 'org': retained['org'], 'providerSecret': secrets.token_urlsafe(32), 'oauthSecret': secrets.token_urlsafe(32)})
    print('Retained owner API key loaded privately; synthetic credentials generated.')


def discover():
    status, schema = client.request('discovery-openapi', 'GET', '/openapi.json')
    if status != 200:
        raise RuntimeError('Live OpenAPI unavailable')
    (ROOT / 'openapi.json').write_text(json.dumps(schema))
    print('Live OpenAPI info:', json.dumps(schema.get('info')))
    groups = {
        'provider-management': r'/llm-providers',
        'usability-models': r'/(models|test|validate)(/|$)',
        'usability-completion': r'completion|/chat(/|$)|/inference',
        'job-resources': r'^/v1/(members|org)$|^/v1/(teams|desktop-policies|marketplaces)/by-key|^/v1/mcp-connections(/by-key|/\{connectionId\}(/connect|/tools|$))',
    }
    for group, pattern in groups.items():
        print(group)
        for path, methods in schema['paths'].items():
            if re.search(pattern, path):
                print(path, ','.join(methods.keys()))


def contracts():
    schema = json.loads((ROOT / 'openapi.json').read_text())
    def expand(value, seen=()):
        if isinstance(value, dict):
            if '$ref' in value:
                ref = value['$ref']
                if ref in seen:
                    return value
                target = schema
                for part in ref.removeprefix('#/').split('/'):
                    target = target[part]
                return expand(target, (*seen, ref))
            return {k: expand(v, seen) for k, v in value.items()}
        if isinstance(value, list):
            return [expand(v, seen) for v in value]
        return value
    output = {}
    for path in sys.argv[2:]:
        output[path] = {method: {'parameters': expand(value.get('parameters', [])), 'requestBody': expand(value.get('requestBody')), 'responses': list(value.get('responses', {})), 'summary': value.get('summary'), 'description': value.get('description')} for method, value in schema['paths'].get(path, {}).items() if isinstance(value, dict)}
    (ROOT / 'contracts.json').write_text(json.dumps(output, indent=2))
    print('Selected live contracts saved privately.')


def witness_env():
    state = client.load()
    (ROOT / 'witness.env').write_text('PROVIDER_SECRET=' + state['providerSecret'] + '\nOAUTH_SECRET=' + state['oauthSecret'] + '\n')
    print('Private witness environment written.')


def baseline():
    for label, path in [('org', '/v1/org'), ('providers', '/v1/llm-providers?scope=manageable'), ('policies', '/v1/desktop-policies'), ('marketplaces', '/v1/marketplaces')]:
        status, payload = client.request('baseline-' + label, 'GET', path)
        print(label, 'response keys', list(payload) if isinstance(payload, dict) else 'non-object')
        (ROOT / ('baseline-' + label + '.json')).write_text(json.dumps(payload))


def run():
    state = client.load()
    env = dict(os.environ, DEN_API_URL='http://localhost:18788', DEN_API_KEY=state['key'], LLM_API_KEY=state['providerSecret'], OAUTH_CLIENT_SECRET=state['oauthSecret'], MEMBER_EMAIL='release-admin@example.com')
    if sys.argv[-1] == 'run2':
        env['OMIT_OAUTH_CLIENT_SECRET'] = '1'
    else:
        env['OMIT_OAUTH_CLIENT_SECRET'] = '0'
    script = pathlib.Path('examples/declarative-org/rs-post-deploy-job.sh')
    args = ['bash', str(script), *sys.argv[2:]]
    invocation = {'argv': args, 'mode': args[2], 'runLabel': args[3] if len(args) > 3 else None, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scriptSha256': hashlib.sha256(script.read_bytes()).hexdigest(), 'exitCode': None, 'curlExecutable': shutil.which('curl', path=env['PATH']), 'jqExecutable': shutil.which('jq', path=env['PATH'])}
    index = len(list(ROOT.glob('invocation-*.json')))
    path = ROOT / f'invocation-{index:03d}.json'
    try:
        result = subprocess.run(args, env=env)
        invocation['exitCode'] = result.returncode
    finally:
        invocation['endedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        invocation['scriptSha256After'] = hashlib.sha256(script.read_bytes()).hexdigest()
        invocation['scriptUnchanged'] = invocation['scriptSha256'] == invocation['scriptSha256After']
        path.write_text(json.dumps(invocation, indent=2))
    print('Job exit:', result.returncode)
    if not invocation['scriptUnchanged']:
        raise RuntimeError('Job script changed during execution')
    sys.exit(result.returncode)


def compare():
    first = json.loads((ROOT / 'snapshot-run1.json').read_text())
    second = json.loads((ROOT / 'snapshot-run2.json').read_text())
    statuses = json.loads((ROOT / 'run2-convergent-statuses.json').read_text())
    result = {'countsAndIdsIdentical': first == second, 'run2ConvergentAll200': len(statuses) == 7 and all(row['status'] == 200 for row in statuses), 'snapshots': {'run1': first, 'run2': second}, 'run2ConvergentStatuses': statuses}
    (ROOT / 'comparison.json').write_text(json.dumps(result, indent=2))
    print('Counts/IDs identical:', result['countsAndIdsIdentical'], 'run2 seven convergent mutations all 200:', result['run2ConvergentAll200'])
    if not result['countsAndIdsIdentical'] or not result['run2ConvergentAll200']:
        raise RuntimeError('Stable-state comparison failed')


def controls():
    existing = json.loads((ROOT / 'unkeyed-state.json').read_text())
    status, row = client.request('control-unkeyed-read', 'GET', '/v1/mcp-connections/' + existing['id'])
    update = client.jq('{expectedUpdatedAt,name:"Lane3 stale control",url,authType,credentialMode,exposeDirectly,access}', {**row, 'expectedUpdatedAt': existing['updatedAt']})
    client.request('control-unkeyed-stale', 'PUT', '/v1/mcp-connections/' + existing['id'], update)
    client.request('control-unkeyed-after-stale', 'GET', '/v1/mcp-connections/' + existing['id'])
    client.request('control-provider-missing-credential', 'POST', '/v1/llm-providers/test-connection', {'api': os.environ['STUB_URL'] + '/v1', 'modelIds': ['lane3-model']})
    oauth = json.loads((ROOT / 'run2-oauth-state.json').read_text())
    item = '/v1/mcp-connections/' + oauth['id']
    status, row = client.request('control-oauth-before-first-connect', 'GET', item)
    if row.get('connected') is not False:
        raise RuntimeError('Expected no existing OAuth token before proving secret retention')
    status, payload = client.request('control-oauth-start', 'GET', item + '/connect/start')
    if status != 200 or not payload.get('authorizeUrl'):
        print('OAuth protocol blocked at connect/start; inspect private receipt. No retention claim.')
        return
    authorized = urllib.parse.urlsplit(payload['authorizeUrl'])
    expected = urllib.parse.urlsplit(os.environ['STUB_URL'])
    if (authorized.scheme, authorized.netloc) != (expected.scheme, expected.netloc):
        raise RuntimeError('Authorization URL does not target the synthetic fixture')
    status, _ = client.request('control-oauth-synthetic-consent', 'GET', authorized.path + '?' + authorized.query, auth='none', base=os.environ['STUB_URL'])
    if status != 302:
        print('Synthetic authorization did not redirect; retention not proven.')
        return
    last = sorted(ROOT.glob('request-*.headers'))[-1].read_text()
    location = re.search(r'^location:\s*(.+)$', last, re.MULTILINE | re.IGNORECASE)
    if not location:
        raise RuntimeError('Authorization redirect missing')
    callback = urllib.parse.urlsplit(location.group(1).strip())
    if callback.scheme != 'http' or callback.hostname not in ['localhost', '127.0.0.1'] or callback.port != 18788:
        raise RuntimeError('OAuth callback does not target this release stack')
    client.request('control-oauth-callback', 'GET', callback.path + '?' + callback.query)
    client.request('control-oauth-after-connect', 'GET', item)
    client.request('control-oauth-tool', 'POST', item + '/tools/call', {'toolName': 'lane3_witness', 'arguments': {'nonce': 'after-client-secret-omission'}})


def negative_oauth():
    client.request('control-oauth-missing-client-secret', 'POST', '/token', {'client_id': 'lane3-client', 'grant_type': 'authorization_code', 'code': 'synthetic-negative-control'}, auth='none', base=os.environ['STUB_URL'])


def export():
    destination = pathlib.Path(sys.argv[2])
    supersedes = os.environ.get('PROOF_SUPERSEDES_SHA256')
    if destination.exists() and (not supersedes or hashlib.sha256(destination.read_bytes()).hexdigest() != supersedes):
        raise RuntimeError('Refusing to replace a transcript without its exact authorized prior digest')
    invocations = [json.loads(path.read_text()) for path in sorted(ROOT.glob('invocation-*.json'))]
    applies = [row for row in invocations if row['mode'] == 'apply']
    if len(applies) != 2 or [row['runLabel'] for row in applies] != ['run1', 'run2']:
        raise RuntimeError('Expected exactly two actual apply invocations, run1 then run2')
    execution_sha = applies[0]['scriptSha256']
    if any(not row['scriptUnchanged'] or row['scriptSha256'] != execution_sha for row in invocations):
        raise RuntimeError('Invocation script digests differ')
    state = client.load()
    hidden = [state['key'], state['providerSecret'], state['oauthSecret']]
    def clean(value):
        from mcp_proof_redaction import sanitize
        return sanitize(value, hidden)
    paths = sorted([*ROOT.glob('request-*.json'), *ROOT.glob('job-*.json')], key=lambda path: path.stat().st_mtime_ns)
    receipts = [json.loads(path.read_text()) for path in paths]
    checks = []
    for label in ['run1-provider-connect', 'run2-provider-connect']:
        receipt = next(row for row in receipts if row['label'] == label)
        provider = receipt['response']['body']['llmProvider']
        checks.append({'label': label, 'storedCredentialPresent': bool(provider.get('apiKey')), 'storedCredentialMatchesConfigured': provider.get('apiKey') == state['providerSecret']})
    immutable = {}
    for name, expected in [('mcp-put-by-key-transcript-2026-09-14.json', 'c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc'), ('mcp-put-by-key-tenant-transcript-2026-09-14.json', '8df72de0df9edc56606aa0f72e5d40f448ea26afd726da503327787682d7ca0e')]:
        digest = hashlib.sha256((pathlib.Path('reports') / name).read_bytes()).hexdigest()
        if digest != expected:
            raise RuntimeError('Prior lane transcript changed')
        immutable[name] = digest
    image_id = subprocess.check_output(['docker', 'inspect', 'mcp-put-proof-release-den-1', '--format', '{{.Image}}'], text=True).strip()
    inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image_id, '--format', '{"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}},"architecture":{{json .Architecture}}}'], text=True))
    inspection['imageId'] = image_id
    inspection['containerImage'] = subprocess.check_output(['docker', 'inspect', 'mcp-put-proof-release-den-1', '--format', '{{.Config.Image}}'], text=True).strip()
    inspection['composeSha256'] = hashlib.sha256(pathlib.Path('packaging/docker/docker-compose.eval.yml').read_bytes()).hexdigest()
    witness = [json.loads(line) for line in (ROOT / 'witness.jsonl').read_text().splitlines()]
    output = {'schemaVersion': 2, 'kind': 'recorded-release-post-deploy-job', 'recordingRevision': 2, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'supersedesTranscriptSha256': supersedes, 'inspection': inspection, 'jobSha256': execution_sha, 'jobInvocations': clean(applies), 'otherInvocations': clean([row for row in invocations if row['mode'] != 'apply']), 'priorTranscripts': immutable, 'comparison': json.loads((ROOT / 'comparison.json').read_text()), 'credentialChecksBeforeRedaction': checks, 'expectedSyntheticClientSecretFingerprint': hashlib.sha256(state['oauthSecret'].encode()).hexdigest()[:16], 'expectedSyntheticProviderSecretFingerprint': hashlib.sha256(state['providerSecret'].encode()).hexdigest()[:16], 'testkit': 'deferred_to_orchestrator', 'witnessReceipts': clean(witness), 'requests': clean(receipts)}
    serialized = json.dumps(output, indent=2) + '\n'
    if any(secret in serialized for secret in hidden):
        raise RuntimeError('Secret remains; refusing export')
    if destination.exists():
        (ROOT / 'superseded-lane3-transcript.json').write_bytes(destination.read_bytes())
    destination.write_text(serialized)
    print('Sanitized Lane3 receipts exported:', len(receipts), 'upstream witness receipts:', len(witness), 'actual apply invocations:', len(applies))


if __name__ == '__main__':
    {'prepare': prepare, 'discover': discover, 'contracts': contracts, 'witness-env': witness_env, 'baseline': baseline, 'run': run, 'compare': compare, 'controls': controls, 'negative-oauth': negative_oauth, 'export': export}[sys.argv[1]]()

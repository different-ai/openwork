import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(os.environ['PROOF_PRIVATE_DIR'])
BASE = os.environ.get('DEN_API_URL', 'http://localhost:18788')
STATE = ROOT / 'state.json'
os.umask(0o077)


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    STATE.write_text(json.dumps(state))


def jq(expression, value):
    result = subprocess.run(['jq', '-c', expression], input=json.dumps(value), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def request(label, method, path, body=None, auth='key', org=None, base=BASE):
    state = load()
    headers = {'Content-Type': 'application/json'}
    if auth == 'session':
        headers['Authorization'] = 'Bearer ' + state['session']
        headers['Origin'] = os.environ.get('PROOF_WEB_ORIGIN', 'http://localhost:13005')
    elif auth != 'none':
        headers['x-api-key'] = state[auth]
    if org:
        headers['x-openwork-org-id'] = org
    index = len(list(ROOT.glob('request-*.json')))
    stem = ROOT / f'request-{index:03d}'
    config = ''.join('header = ' + json.dumps(k + ': ' + v) + '\n' for k, v in headers.items())
    args = ['curl', '--silent', '--show-error', '--max-time', '100', '--config', '-', '-X', method, '-D', str(stem) + '.headers', '-o', str(stem) + '.body', '-w', '%{http_code}', base + path]
    if body is not None:
        pathlib.Path(str(stem) + '.input').write_text(json.dumps(body))
        args.extend(['--data-binary', '@' + str(stem) + '.input'])
    start = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = subprocess.run(args, input=config, text=True, capture_output=True)
    raw = pathlib.Path(str(stem) + '.body').read_text() if pathlib.Path(str(stem) + '.body').exists() else ''
    try:
        parsed = json.loads(subprocess.run(['jq', '-c', '.'], input=raw, text=True, capture_output=True, check=True).stdout)
    except (ValueError, subprocess.CalledProcessError):
        parsed = raw
    receipt = {'label': label, 'at': start, 'request': {'method': method, 'url': base + path, 'headers': headers, 'body': body}, 'response': {'status': int(result.stdout or '0'), 'headers': pathlib.Path(str(stem) + '.headers').read_text(), 'body': parsed}, 'curlExit': result.returncode, 'stderr': result.stderr}
    pathlib.Path(str(stem) + '.json').write_text(json.dumps(receipt))
    print(label, receipt['response']['status'], flush=True)
    return receipt['response']['status'], parsed


def bootstrap():
    env = dict(line.split('=', 1) for line in (ROOT / 'release.env').read_text().splitlines())
    request('setup-status-before', 'GET', '/v1/auth/bootstrap/status', auth='none')
    status, payload = request('setup-verify', 'POST', '/v1/auth/bootstrap/verify', {'email': env['OPENWORK_OWNER_EMAILS'], 'code': env['OPENWORK_SETUP_CODE']}, auth='none')
    if status != 200:
        print(json.dumps(payload))
        return
    status, payload = request('setup-signup', 'POST', '/api/auth/sign-up/email', {'email': env['OPENWORK_OWNER_EMAILS'], 'name': 'Release Administrator', 'password': (ROOT / 'password').read_text(), 'bootstrapGrant': payload['grant']}, auth='none')
    if status != 200:
        print('Account bootstrap failed; inspect private receipt.')
        return
    state = load()
    state['session'] = payload['token']
    save(state)
    request('setup-status-after', 'GET', '/v1/auth/bootstrap/status', auth='none')
    status, payload = request('setup-org', 'GET', '/v1/org', auth='session')
    if status != 200:
        print('Organization setup failed; inspect private receipt.')
        return
    state['org'] = payload['organization']['id']
    save(state)
    status, payload = request('setup-api-key', 'POST', '/v1/api-keys', {'name': 'Release black-box proof'}, auth='session', org=state['org'])
    if status == 201:
        state['key'] = payload['key']
        save(state)


def export(destination):
    if pathlib.Path(destination).exists():
        raise RuntimeError('Refusing to overwrite a saved release transcript')
    state = load()
    secrets = [v for k, v in state.items() if k in ['session', 'key', 'foreignKey']]
    secrets += [(ROOT / 'password').read_text()]
    secrets += [line.split('=', 1)[1] for name in ['release.env', 'witness.env'] for line in (ROOT / name).read_text().splitlines() if any(word in line.split('=', 1)[0] for word in ['SECRET', 'KEY', 'CODE'])]
    def clean(value):
        from mcp_proof_redaction import sanitize
        return sanitize(value, secrets)
    receipts = [json.loads(path.read_text()) for path in sorted(ROOT.glob('request-*.json'))]
    image_id = subprocess.check_output(['docker', 'inspect', 'mcp-put-proof-release-den-1', '--format', '{{.Image}}'], text=True).strip()
    inspection = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image_id, '--format', '{"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}},"architecture":{{json .Architecture}}}'], text=True))
    inspection['imageId'] = image_id
    inspection['containerImage'] = subprocess.check_output(['docker', 'inspect', 'mcp-put-proof-release-den-1', '--format', '{{.Config.Image}}'], text=True).strip()
    inspection['composeSha256'] = hashlib.sha256(pathlib.Path('packaging/docker/docker-compose.eval.yml').read_bytes()).hexdigest()
    inspection['dockerServerVersion'] = subprocess.check_output(['docker', 'version', '--format', '{{.Server.Version}}'], text=True).strip()
    secret = dict(line.split('=', 1) for line in (ROOT / 'witness.env').read_text().splitlines())['WITNESS_SECRET']
    secret_checks = [{'label': r['label'], 'rawResponseContainsWitnessSecret': secret in json.dumps(r['response']), 'responseHasApiKeyField': 'apiKey' in r['response']['body']} for r in receipts if r['label'] in ['case6-secret-create', 'case6-secret-read', 'case6-omit-secret', 'case6-secret-read-after']]
    witness = [json.loads(line) for line in (ROOT / 'witness.jsonl').read_text().splitlines()]
    output = {'schemaVersion': 1, 'kind': 'recorded-release-blackbox', 'image': 'ghcr.io/different-ai/openwork-den-api:0.18.46@sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407', 'inspection': inspection, 'coverage': {'foreignOrgId': 'not_executed_single_org_bootstrap_409', 'testkit': 'deferred_to_orchestrator'}, 'secretChecksBeforeRedaction': secret_checks, 'witnessCalls': [row for row in witness if row['method'] == 'tools/call'], 'requests': clean(receipts)}
    serialized = json.dumps(output, indent=2) + '\n'
    if any(value and value in serialized for value in secrets):
        raise RuntimeError('Secret remains in transcript; refusing export')
    pathlib.Path(destination).write_text(serialized)
    print('Sanitized requests exported:', len(receipts))


if __name__ == '__main__':
    if sys.argv[1] == 'bootstrap':
        bootstrap()
    elif sys.argv[1] == 'export':
        export(sys.argv[2])

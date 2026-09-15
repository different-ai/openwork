import datetime
import hashlib
import importlib
import json
import os
import pathlib
import subprocess
import sys
import time

sys.dont_write_bytecode = True
client = importlib.import_module('mcp-put-release-client')
ROOT = client.ROOT
FIXTURES = pathlib.Path(__file__).parent


def start():
    env = dict(os.environ, PROOF_TLS_CERT=str(ROOT / 'localhost.pem'), PROOF_TLS_KEY=str(ROOT / 'localhost.key'))
    with (ROOT / 'proxy.jsonl').open('w') as stdout, (ROOT / 'proxy.stderr').open('w') as stderr:
        process = subprocess.Popen([sys.executable, str(FIXTURES / 'mcp-put-release-witness.py'), 'proxy'], env=env, stdout=stdout, stderr=stderr, start_new_session=True)
    (ROOT / 'proxy.pid').write_text(str(process.pid))
    print('Started loopback TLS proxy.')


def recipe():
    source = pathlib.Path(os.environ['PROOF_RCA_PATH']).read_text().splitlines()[143:146]
    recipe_path = FIXTURES / 'mcp-put-release-recipe.sh'
    if recipe_path.read_text().splitlines() != source:
        raise RuntimeError('Recipe differs from RCA lines 144-146')
    client.request('tls-untrusted-control', 'GET', '/health', auth='none', base='https://localhost:18443')
    env = dict(os.environ, CURL_CA_BUNDLE=str(ROOT / 'ca.pem'), DEN_API_URL='https://localhost:18443', DEN_API_KEY=client.load()['key'], MCP_NAME='Release exact recipe', MCP_URL=os.environ['PROOF_MCP_BASE'] + '/public')
    for label in ['recipe-first', 'recipe-second']:
        previous = len((ROOT / 'proxy.jsonl').read_text().splitlines())
        args = ['bash', os.path.relpath(recipe_path)]
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        script_sha = hashlib.sha256(recipe_path.read_bytes()).hexdigest()
        result = subprocess.run(args, env=env, text=True, capture_output=True)
        ended_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (ROOT / (label + '.stdout')).write_text(result.stdout)
        (ROOT / (label + '.stderr')).write_text(result.stderr)
        time.sleep(0.1)
        rows = (ROOT / 'proxy.jsonl').read_text().splitlines()[previous:]
        if len(rows) != 1:
            raise RuntimeError('Expected one exact recipe request; inspect private proxy log without retrying')
        receipt = json.loads(rows[0])
        receipt['label'] = label
        receipt['request']['url'] = 'https://localhost:18443' + receipt['request'].pop('path')
        observed_headers = {name.lower(): value for name, value in receipt['request']['headers'].items()}
        receipt['observedKeyMatchesConfigured'] = observed_headers.get('x-api-key') == client.load()['key']
        receipt['recipe'] = {'source': 'reports/rca-mcp-put-endpoint-2026-09-14.md:144-146', 'verbatim': True, 'lines': source, 'argv': args, 'startedAt': started_at, 'endedAt': ended_at, 'scriptSha256': script_sha, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr, 'CURL_CA_BUNDLE': 'private/ca.pem', 'tlsVerification': True}
        index = len(list(ROOT.glob('request-*.json')))
        (ROOT / f'request-{index:03d}.json').write_text(json.dumps(receipt))
        print(label, receipt['response']['status'], 'pipeline exit', result.returncode)
        if result.returncode != 0 or receipt['response']['status'] != (201 if label == 'recipe-first' else 200):
            raise RuntimeError('Exact recipe failed; recorded without retry')
        if not receipt['observedKeyMatchesConfigured'] or 'authorization' in observed_headers or 'cookie' in observed_headers:
            raise RuntimeError('Observed recipe headers do not satisfy API-key-only authentication')


def stop():
    pid = int((ROOT / 'proxy.pid').read_text())
    command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
    if str(FIXTURES / 'mcp-put-release-witness.py') not in command or 'proxy' not in command:
        raise RuntimeError('PID no longer belongs to the proof TLS proxy')
    os.kill(pid, 15)
    print('Stopped proof TLS proxy.')


def cleanup():
    status, payload = client.request('recipe-rerun-cleanup', 'DELETE', '/v1/mcp-connections/by-key/platform-tools')
    if status != 200 or payload.get('deleted') is not True:
        raise RuntimeError('Recipe cleanup failed')
    status, payload = client.request('recipe-rerun-cleanup-list', 'GET', '/v1/mcp-connections?scope=manageable')
    if status != 200 or payload.get('connections') != []:
        raise RuntimeError('Recipe cleanup list is not empty')


def export():
    from mcp_proof_redaction import sanitize
    destination = pathlib.Path(sys.argv[2])
    if destination.exists():
        raise RuntimeError('Refusing to overwrite a saved recipe supplement')
    original = pathlib.Path('reports/mcp-put-by-key-transcript-2026-09-14.json')
    original_sha = hashlib.sha256(original.read_bytes()).hexdigest()
    if original_sha != 'c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc':
        raise RuntimeError('Original 51-receipt transcript changed')
    receipts = [json.loads(path.read_text()) for path in sorted(ROOT.glob('request-*.json'))]
    image = subprocess.check_output(['docker', 'inspect', 'mcp-put-proof-release-den-1', '--format', '{{.Config.Image}}'], text=True).strip()
    output = {'schemaVersion': 1, 'kind': 'released-recipe-observed-headers-rerun', 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'originalTranscriptSha256': original_sha, 'historicalHeadersBackfilled': False, 'containerImage': image, 'requests': sanitize(receipts, [client.load()['key']])}
    destination.write_text(json.dumps(output, indent=2) + '\n')
    print('Observed-header recipe supplement exported:', len(receipts), 'receipts')


if __name__ == '__main__':
    {'start': start, 'recipe': recipe, 'stop': stop, 'cleanup': cleanup, 'export': export}[sys.argv[1]]()

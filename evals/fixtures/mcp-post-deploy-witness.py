import base64
import hashlib
import http.server
import json
import os
import secrets
import time
import urllib.parse

PROVIDER_SECRET = os.environ['PROVIDER_SECRET']
OAUTH_SECRET = os.environ['OAUTH_SECRET']
CODES = {}
TOKENS = set()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        base = 'https://' + self.headers['Host']
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        authorization = self.headers.get('Authorization', '')
        bearer = authorization.removeprefix('Bearer ')
        authenticated = False
        headers = {}
        status = 200
        result = {}
        if path == '/v1/models' or path == '/v1/chat/completions':
            authenticated = bearer == PROVIDER_SECRET
            if not authenticated:
                status, result = 401, {'error': {'message': 'Synthetic provider credential required', 'type': 'authentication_error'}}
            elif path == '/v1/models':
                result = {'object': 'list', 'data': [{'id': 'lane3-model', 'object': 'model', 'owned_by': 'synthetic'}]}
            else:
                result = {'id': 'lane3-completion', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'lane3-model', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
        elif path.startswith('/.well-known/oauth-protected-resource'):
            result = {'resource': base + '/oauth/mcp', 'authorization_servers': [base], 'scopes_supported': ['lane3.read'], 'bearer_methods_supported': ['header']}
        elif path in ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']:
            result = {'issuer': base, 'authorization_endpoint': base + '/authorize', 'token_endpoint': base + '/token', 'response_types_supported': ['code'], 'grant_types_supported': ['authorization_code'], 'code_challenge_methods_supported': ['S256'], 'token_endpoint_auth_methods_supported': ['client_secret_post'], 'scopes_supported': ['lane3.read']}
        elif path == '/authorize':
            redirect = urllib.parse.urlsplit(query.get('redirect_uri', ''))
            if query.get('client_id') != 'lane3-client' or redirect.hostname not in ['localhost', '127.0.0.1'] or redirect.port != 18788 or not query.get('state') or not query.get('code_challenge'):
                status, result = 400, {'error': 'invalid_authorization_request'}
            else:
                code = secrets.token_urlsafe(32)
                CODES[code] = query
                location = query['redirect_uri'] + '?' + urllib.parse.urlencode({'code': code, 'state': query['state'], 'iss': base})
                status, result, headers = 302, {'syntheticConsent': 'granted'}, {'Location': location}
        elif path == '/token':
            authenticated = body.get('client_id') == 'lane3-client' and body.get('client_secret') == OAUTH_SECRET
            saved = CODES.get(body.get('code'))
            challenge = base64.urlsafe_b64encode(hashlib.sha256(body.get('code_verifier', '').encode()).digest()).decode().rstrip('=')
            if not authenticated:
                status, result = 401, {'error': 'invalid_client'}
            elif not saved or saved['redirect_uri'] != body.get('redirect_uri') or saved['code_challenge'] != challenge:
                status, result = 400, {'error': 'invalid_grant'}
            else:
                CODES.pop(body['code'])
                token = secrets.token_urlsafe(32)
                TOKENS.add(token)
                result = {'access_token': token, 'token_type': 'Bearer', 'expires_in': 3600, 'scope': 'lane3.read'}
        elif path in ['/public', '/oauth/mcp']:
            authenticated = path == '/public' or bearer in TOKENS
            if not authenticated:
                status, result = 401, {'error': 'authorization_required'}
                headers['WWW-Authenticate'] = 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/oauth/mcp"'
            elif self.command != 'POST':
                status, result = 405, {}
            elif 'id' not in body:
                status, result = 202, {}
            else:
                method = body.get('method')
                if method == 'initialize':
                    payload = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'Post-deploy synthetic witness', 'version': '1'}}
                elif method == 'tools/list':
                    payload = {'tools': [{'name': 'lane3_witness', 'description': 'Synthetic authorized MCP witness', 'inputSchema': {'type': 'object', 'properties': {'nonce': {'type': 'string'}}}}]}
                elif method == 'tools/call':
                    payload = {'content': [{'type': 'text', 'text': json.dumps({'authenticated': authenticated, 'nonce': body.get('params', {}).get('arguments', {}).get('nonce')})}], 'isError': False}
                else:
                    payload = {}
                result = {'jsonrpc': '2.0', 'id': body['id'], 'result': payload}
        else:
            status, result = 404, {'error': 'not_found'}
        encoded = json.dumps(result).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)
        secret = body.get('client_secret') if path == '/token' else bearer
        safe_body = {k: v for k, v in body.items() if k not in ['client_secret', 'code', 'code_verifier']}
        safe_result = {k: '[REDACTED]' if k in ['access_token', 'refresh_token'] else v for k, v in result.items()}
        print(json.dumps({'at': time.time(), 'request': {'method': self.command, 'path': path, 'body': safe_body, 'secretFingerprint': hashlib.sha256(secret.encode()).hexdigest()[:16] if secret else None}, 'response': {'status': status, 'body': safe_result}, 'authenticated': authenticated}), flush=True)

    do_GET = handle_request
    do_POST = handle_request


http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()

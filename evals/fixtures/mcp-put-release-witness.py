import datetime
import hashlib
import http.client
import http.server
import json
import os
import ssl
import sys

SECRET = os.environ.get('WITNESS_SECRET', '')
MODE = sys.argv[1]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def handle_request(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if MODE == 'proxy':
            connection = http.client.HTTPConnection('127.0.0.1', 18788, timeout=90)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ['host', 'connection']}
            connection.request(self.command, self.path, body=raw, headers=headers)
            upstream = connection.getresponse()
            result = upstream.read()
            self.send_response(upstream.status)
            for k, v in upstream.getheaders():
                if k.lower() not in ['transfer-encoding', 'content-length', 'connection']:
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)
            print(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'request': {'method': self.command, 'path': self.path, 'headers': dict(self.headers.items()), 'headersSource': 'observed_proxy_incoming', 'body': json.loads(raw) if raw else None}, 'response': {'status': upstream.status, 'headers': dict(upstream.getheaders()), 'body': json.loads(result)}}), flush=True)
            connection.close()
            return
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        token = self.headers.get('Authorization', '').removeprefix('Bearer ')
        authorized = self.path == '/public' or (self.path == '/bearer' and bool(SECRET) and token == SECRET)
        status = 401 if not authorized else 405 if self.command != 'POST' else 202 if 'id' not in body else 200
        method = body.get('method', self.command)
        payload = None
        if status == 200:
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'Release proof witness', 'version': '1.0.0'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'release_credential_witness', 'description': 'Synthetic auth-enforcing proof fixture', 'inputSchema': {'type': 'object', 'properties': {'nonce': {'type': 'string'}}, 'required': ['nonce']}, 'annotations': {'readOnlyHint': True}}]}
            elif method == 'tools/call':
                result = {'content': [{'type': 'text', 'text': json.dumps({'authenticated': self.path == '/bearer' and token == SECRET, 'nonce': body.get('params', {}).get('arguments', {}).get('nonce')})}], 'isError': False}
            else:
                result = {}
            payload = {'jsonrpc': '2.0', 'id': body['id'], 'result': result}
        encoded = json.dumps(payload).encode() if payload is not None else b''
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)
        print(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'path': self.path, 'method': method, 'status': status, 'authenticated': self.path == '/bearer' and token == SECRET, 'nonce': body.get('params', {}).get('arguments', {}).get('nonce'), 'tokenId': hashlib.sha256(token.encode()).hexdigest()[:16] if token else None}), flush=True)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request


server = http.server.ThreadingHTTPServer(('127.0.0.1' if MODE == 'proxy' else '0.0.0.0', 18443 if MODE == 'proxy' else 8080), Handler)
if MODE == 'proxy':
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(os.environ['PROOF_TLS_CERT'], os.environ['PROOF_TLS_KEY'])
    server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()

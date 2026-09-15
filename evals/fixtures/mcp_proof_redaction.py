import json
import re
import urllib.parse


SENSITIVE = {
    'authorization', 'proxyauthorization', 'xapikey', 'cookie', 'setcookie',
    'setauthtoken', 'xauthtoken', 'password', 'bootstrapgrant', 'grant', 'token',
    'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'bearertoken',
    'clientsecret', 'oauthclientsecret', 'oauthaccesstoken', 'oauthrefreshtoken',
    'registrationaccesstoken', 'apikey', 'key', 'secret', 'codeverifier',
    'state', 'code', 'start',
}
PARAMETER = re.compile(r'([?#&](?:amp;)?)([^=&#\s"<>]+)=([^&#\s"<>]*)')
HEADER = re.compile(r'(?im)^([ \t]*(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie|set-auth-token|x-auth-token)):[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*')
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')


def normalized(key):
    return re.sub(r'[-_\s]', '', key).lower()


def sanitize(value, secrets):
    replacements = sorted({variant for secret in secrets if isinstance(secret, str) and secret for variant in [secret, urllib.parse.quote(secret, safe=''), urllib.parse.quote_plus(secret), json.dumps(secret)[1:-1]]}, key=len, reverse=True)

    def parameter(match):
        prefix, key, content = match.groups()
        if normalized(urllib.parse.unquote(key)) in SENSITIVE:
            return prefix + key + '=[REDACTED]'
        decoded = urllib.parse.unquote(content)
        if decoded != content:
            cleaned = PARAMETER.sub(parameter, decoded)
            if cleaned != decoded:
                return prefix + key + '=' + urllib.parse.quote(cleaned, safe='')
        return match.group(0)

    def clean(item, key='', header_list=False, schema=False):
        if isinstance(item, dict):
            schema = schema or ('openapi' in item and 'paths' in item)
            credential_header = header_list and not schema and isinstance(item.get('name'), str) and normalized(item['name']) in SENSITIVE
            return {
                name: '[REDACTED]' if credential_header and name == 'value' else clean(content, name, schema=schema or name == 'schema')
                for name, content in item.items()
            }
        if isinstance(item, list):
            return [clean(content, key, header_list=normalized(key) == 'headers', schema=schema) for content in item]
        if not isinstance(item, str):
            return item
        if not schema and normalized(key) in SENSITIVE:
            return '[REDACTED]'
        for secret in replacements:
            item = item.replace(secret, '[REDACTED]')
        if item.lstrip().startswith(('{', '[')):
            try:
                parsed = json.loads(item)
            except ValueError:
                pass
            else:
                if isinstance(parsed, (dict, list)):
                    cleaned = clean(parsed, schema=schema)
                    if cleaned != parsed:
                        item = json.dumps(cleaned)
        item = HEADER.sub(lambda match: match.group(1) + ': [REDACTED]', item)
        item = PARAMETER.sub(parameter, item)
        item = re.sub(r'(https?://)[^/\s"<>]*@', r'\1[REDACTED]@', item)
        return EMAIL.sub(lambda match: match.group(0) if match.group(0).lower().endswith('@example.com') else '[REDACTED_EMAIL]', item)

    return clean(value)

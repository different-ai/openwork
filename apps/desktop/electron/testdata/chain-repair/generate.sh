#!/usr/bin/env bash
set -euo pipefail

# Regenerates the committed TLS chain-repair fixtures. The leaf intentionally
# carries an AIA caIssuers URL that points at an unroutable local test port; the
# tests inject the fetched intermediate bytes rather than doing network I/O.

cd "$(dirname "$0")"

rm -f root.pem root.key.pem intermediate.pem intermediate.key.pem intermediate.der leaf.pem leaf.key.pem *.csr *.srl *.cnf *.ext

cat > root.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = OpenWork Test Chain Root

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:1
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF

cat > intermediate.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no

[dn]
CN = OpenWork Test Chain Intermediate
EOF

cat > intermediate.ext <<'EOF'
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

cat > leaf.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no

[dn]
CN = localhost
EOF

cat > leaf.ext <<'EOF'
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
authorityInfoAccess = caIssuers;URI:http://127.0.0.1:1/int.der
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key.pem -out root.pem -days 8700 -sha256 -config root.cnf
openssl req -newkey rsa:2048 -nodes -keyout intermediate.key.pem -out intermediate.csr -config intermediate.cnf
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key.pem -CAcreateserial -out intermediate.pem -days 8700 -sha256 -extfile intermediate.ext
openssl req -newkey rsa:2048 -nodes -keyout leaf.key.pem -out leaf.csr -config leaf.cnf
openssl x509 -req -in leaf.csr -CA intermediate.pem -CAkey intermediate.key.pem -CAcreateserial -out leaf.pem -days 8700 -sha256 -extfile leaf.ext
openssl x509 -in intermediate.pem -outform DER -out intermediate.der

rm -f *.csr *.srl *.cnf *.ext

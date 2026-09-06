#!/usr/bin/env bash

# OpenWork Network Doctor for macOS/Linux.
# Read-only support report. Bash 3.2-compatible for the default macOS shell.

SCRIPT_VERSION="v1"

trap 'exit 0' EXIT

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

section() {
  printf '\n===== %s =====\n' "$1"
}

print_block() {
  if [ -z "$1" ]; then
    printf '  (no output)\n'
    return
  fi

  printf '%s\n' "$1" | while IFS= read -r line; do
    printf '  %s\n' "$line"
  done
}

normalize_host() {
  host_value="$1"
  host_value="${host_value#http://}"
  host_value="${host_value#https://}"
  host_value="${host_value%%/*}"
  host_value="${host_value%%:*}"
  printf '%s\n' "$host_value"
}

run_with_timeout() {
  timeout_seconds="$1"
  shift

  if command_exists timeout; then
    timeout "$timeout_seconds" "$@"
  elif command_exists gtimeout; then
    gtimeout "$timeout_seconds" "$@"
  elif command_exists perl; then
    perl -e 'my $seconds = shift @ARGV; alarm $seconds; exec @ARGV; exit 127;' "$timeout_seconds" "$@"
  else
    "$@"
  fi
}

redact_log_line() {
  if command_exists sed; then
    printf '%s\n' "$1" | sed -E \
      -e 's/(access_token|refresh_token|id_token|token|api_key|apikey|client_secret)=([^&[:space:]]+)/\1=[redacted]/g' \
      -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/=-]+/\1[redacted]/g'
  else
    printf '%s\n' "$1"
  fi
}

compact_log_line() {
  compact_line="$(redact_log_line "$1")"
  max_chars="800"
  if [ "${#compact_line}" -gt "$max_chars" ]; then
    printf '%s...[truncated]\n' "${compact_line:0:$max_chars}"
  else
    printf '%s\n' "$compact_line"
  fi
}

report_system() {
  section "SYSTEM"
  printf 'Script version: %s\n' "$SCRIPT_VERSION"
  if command_exists date; then
    printf 'Date: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
  else
    printf 'Date: tool not available (date)\n'
  fi

  if command_exists uname; then
    printf 'Kernel: %s\n' "$(uname -srm 2>/dev/null)"
  else
    printf 'Kernel: tool not available (uname)\n'
  fi

  os_name="$(uname -s 2>/dev/null)"
  case "$os_name" in
    Darwin)
      if command_exists sw_vers; then
        printf 'OS: %s %s (%s)\n' "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" "$(sw_vers -buildVersion 2>/dev/null)"
      else
        printf 'OS: Darwin (sw_vers tool not available)\n'
      fi
      ;;
    Linux)
      if [ -r /etc/os-release ] && command_exists sed; then
        linux_pretty_name="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | sed 's/^"//; s/"$//' | sed -n '1p')"
        if [ -n "$linux_pretty_name" ]; then
          printf 'OS: %s\n' "$linux_pretty_name"
        else
          printf 'OS: Linux\n'
        fi
      else
        printf 'OS: Linux (/etc/os-release unavailable)\n'
      fi
      ;;
    *)
      printf 'OS: %s\n' "${os_name:-unknown}"
      ;;
  esac
}

report_dns() {
  section "DNS"
  os_name="$(uname -s 2>/dev/null)"

  case "$os_name" in
    Darwin)
      if command_exists dscacheutil; then
        printf 'dscacheutil -q host -a name %s:\n' "$TARGET_HOST"
        dns_output="$(dscacheutil -q host -a name "$TARGET_HOST" 2>&1)"
        print_block "$dns_output"
      else
        printf 'dscacheutil: tool not available\n'
      fi

      if command_exists nslookup; then
        printf 'nslookup %s:\n' "$TARGET_HOST"
        dns_output="$(nslookup "$TARGET_HOST" 2>&1)"
        print_block "$dns_output"
      else
        printf 'nslookup: tool not available\n'
      fi

      printf 'grep nameserver /etc/resolv.conf:\n'
      if [ -r /etc/resolv.conf ] && command_exists grep; then
        dns_output="$(grep nameserver /etc/resolv.conf 2>&1)"
        print_block "$dns_output"
      elif [ ! -r /etc/resolv.conf ]; then
        printf '  /etc/resolv.conf not readable\n'
      else
        printf '  grep: tool not available\n'
      fi
      ;;
    Linux)
      if command_exists getent; then
        printf 'getent hosts %s:\n' "$TARGET_HOST"
        dns_output="$(getent hosts "$TARGET_HOST" 2>&1)"
        print_block "$dns_output"
      else
        printf 'getent: tool not available\n'
      fi

      if command_exists nslookup; then
        printf 'nslookup %s:\n' "$TARGET_HOST"
        dns_output="$(nslookup "$TARGET_HOST" 2>&1)"
        print_block "$dns_output"
      else
        printf 'nslookup: tool not available\n'
      fi
      ;;
    *)
      if command_exists nslookup; then
        printf 'nslookup %s:\n' "$TARGET_HOST"
        dns_output="$(nslookup "$TARGET_HOST" 2>&1)"
        print_block "$dns_output"
      else
        printf 'nslookup: tool not available\n'
      fi
      ;;
  esac

  printf 'Note: differing answers between resolvers can indicate split-horizon DNS (VPN/internal DNS vs public DNS).\n'
}

report_tcp() {
  section "TCP"
  if command_exists nc; then
    os_name="$(uname -s 2>/dev/null)"
    if [ "$os_name" = "Darwin" ]; then
      nc -z -G 5 "$TARGET_HOST" "$TARGET_PORT" >/dev/null 2>&1
    else
      nc -z -w 5 "$TARGET_HOST" "$TARGET_PORT" >/dev/null 2>&1
    fi
    tcp_status=$?
    if [ "$tcp_status" -eq 0 ]; then
      printf 'OK: connected to %s:%s (nc).\n' "$TARGET_HOST" "$TARGET_PORT"
    else
      printf 'FAILED: could not connect to %s:%s (nc exit %s).\n' "$TARGET_HOST" "$TARGET_PORT" "$tcp_status"
    fi
    return
  fi

  if command_exists perl; then
    perl -MIO::Socket::INET -e 'my ($host, $port) = @ARGV; my $socket = IO::Socket::INET->new(PeerHost => $host, PeerPort => $port, Proto => "tcp", Timeout => 5); exit($socket ? 0 : 1);' "$TARGET_HOST" "$TARGET_PORT"
    tcp_status=$?
    if [ "$tcp_status" -eq 0 ]; then
      printf 'OK: connected to %s:%s (perl IO::Socket::INET).\n' "$TARGET_HOST" "$TARGET_PORT"
    else
      printf 'FAILED: could not connect to %s:%s (perl IO::Socket::INET).\n' "$TARGET_HOST" "$TARGET_PORT"
    fi
    return
  fi

  if command_exists timeout || command_exists gtimeout; then
    # shellcheck disable=SC2016
    run_with_timeout 5 bash -c ': >/dev/tcp/"$1"/"$2"' bash "$TARGET_HOST" "$TARGET_PORT" >/dev/null 2>&1
    tcp_status=$?
    if [ "$tcp_status" -eq 0 ]; then
      printf 'OK: connected to %s:%s (/dev/tcp).\n' "$TARGET_HOST" "$TARGET_PORT"
    else
      printf 'FAILED: could not connect to %s:%s (/dev/tcp exit %s).\n' "$TARGET_HOST" "$TARGET_PORT" "$tcp_status"
    fi
    return
  fi

  printf 'tool not available: nc, perl, and timeout/gtimeout for /dev/tcp are unavailable.\n'
}

report_tls_chain() {
  section "TLS CHAIN"
  if ! command_exists openssl; then
    printf 'openssl: tool not available\n'
    return
  fi

  printf 'Command: openssl s_client -connect %s:%s -servername %s -showcerts\n' "$TARGET_HOST" "$TARGET_PORT" "$TARGET_HOST"
  tls_output="$(run_with_timeout 15 openssl s_client -connect "$TARGET_HOST:$TARGET_PORT" -servername "$TARGET_HOST" -showcerts < /dev/null 2>&1)"
  tls_status=$?
  if [ "$tls_status" -ne 0 ]; then
    printf 'OpenSSL exit status: %s (continuing with captured output).\n' "$tls_status"
  fi

  if command_exists grep; then
    cert_count="$(printf '%s\n' "$tls_output" | grep -c 'BEGIN CERT')"
  else
    cert_count="0"
    printf 'grep: tool not available; certificate count unavailable.\n'
  fi
  case "$cert_count" in
    ''|*[!0-9]*) cert_count="0" ;;
  esac
  printf 'Certificates served: %s\n' "$cert_count"

  if command_exists awk; then
    chain_summary="$(printf '%s\n' "$tls_output" | awk '
      /^Certificate chain/ { in_chain = 1; next }
      /^Server certificate/ { in_chain = 0 }
      in_chain && /^[[:space:]]*([0-9]+[[:space:]]+s:|i:)/ { print }
    ')"
    printf 'Certificate subjects/issuers (s:/i: lines):\n'
    print_block "$chain_summary"
  else
    printf 'awk: tool not available; subject/issuer summary unavailable.\n'
  fi

  if command_exists grep && command_exists tail; then
    verify_line="$(printf '%s\n' "$tls_output" | grep 'Verify return code:' | tail -n 1)"
  else
    verify_line=""
  fi
  if [ -n "$verify_line" ]; then
    printf '%s\n' "$verify_line"
  else
    printf 'Verify return code: (not found)\n'
  fi

  if command_exists awk; then
    leaf_not_after="$(printf '%s\n' "$tls_output" | awk '
      /-----BEGIN CERTIFICATE-----/ { in_cert = 1 }
      in_cert { print }
      /-----END CERTIFICATE-----/ && in_cert { exit }
    ' | openssl x509 -noout -enddate 2>/dev/null)"
    leaf_not_after="${leaf_not_after#notAfter=}"
    if [ -n "$leaf_not_after" ]; then
      printf 'Leaf notAfter: %s\n' "$leaf_not_after"
    else
      printf 'Leaf notAfter: unavailable\n'
    fi
  else
    printf 'Leaf notAfter: unavailable (awk tool not available)\n'
  fi

  verify_ok="no"
  case "$verify_line" in
    *"Verify return code: 0"*) verify_ok="yes" ;;
  esac

  if [ "$cert_count" -ge 2 ] && [ "$verify_ok" = "yes" ]; then
    printf 'CHAIN OK (%s certs)\n' "$cert_count"
  elif [ "$cert_count" -lt 2 ]; then
    printf 'CHAIN INCOMPLETE: server sent only the leaf certificate - non-browser clients (OpenWork engine, Node, Java) will fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE; browsers hide this. Fix: serve fullchain at the TLS terminator.\n'
  else
    printf 'CHAIN NOT TRUSTED: server sent %s certs, but OpenSSL verify did not return 0. Inspect issuer, trust roots, TLS interception, and NODE_EXTRA_CA_CERTS.\n' "$cert_count"
  fi
}

report_trust_environment() {
  section "TRUST ENVIRONMENT"
  if [ "${NODE_EXTRA_CA_CERTS+x}" = "x" ] && [ -n "$NODE_EXTRA_CA_CERTS" ]; then
    printf 'NODE_EXTRA_CA_CERTS: set\n'
    printf 'NODE_EXTRA_CA_CERTS path: %s\n' "$NODE_EXTRA_CA_CERTS"
    if [ -f "$NODE_EXTRA_CA_CERTS" ]; then
      if [ -r "$NODE_EXTRA_CA_CERTS" ]; then
        if command_exists grep; then
          extra_count="$(grep -c 'BEGIN CERT' "$NODE_EXTRA_CA_CERTS" 2>/dev/null)"
          printf 'NODE_EXTRA_CA_CERTS file: exists/readable, certificates=%s\n' "$extra_count"
        else
          printf 'NODE_EXTRA_CA_CERTS file: exists/readable, certificate count unavailable (grep tool not available)\n'
        fi
      else
        printf 'NODE_EXTRA_CA_CERTS file: exists but not readable\n'
      fi
    else
      printf 'NODE_EXTRA_CA_CERTS file: not found\n'
    fi
  elif [ "${NODE_EXTRA_CA_CERTS+x}" = "x" ]; then
    printf 'NODE_EXTRA_CA_CERTS: set but empty\n'
  else
    printf 'NODE_EXTRA_CA_CERTS: not set\n'
  fi

  if command_exists node; then
    system_ca_count="$(node -p '(function(){try{return require("tls").getCACertificates("system").length;}catch(e){return "unavailable: "+e.message;}})()' 2>&1)"
    default_ca_count="$(node -p '(function(){try{return require("tls").getCACertificates("default").length;}catch(e){return "unavailable: "+e.message;}})()' 2>&1)"
    printf 'node tls.getCACertificates("system").length: %s\n' "$system_ca_count"
    printf 'node tls.getCACertificates("default").length: %s\n' "$default_ca_count"
  else
    printf 'node: tool not available\n'
  fi
}

report_proxy() {
  section "PROXY"
  proxy_names=""
  if [ "${HTTP_PROXY+x}" = "x" ]; then proxy_names="$proxy_names HTTP_PROXY"; fi
  if [ "${HTTPS_PROXY+x}" = "x" ]; then proxy_names="$proxy_names HTTPS_PROXY"; fi
  if [ "${NO_PROXY+x}" = "x" ]; then proxy_names="$proxy_names NO_PROXY"; fi
  if [ "${ALL_PROXY+x}" = "x" ]; then proxy_names="$proxy_names ALL_PROXY"; fi

  if [ -n "$proxy_names" ]; then
    printf 'Set proxy environment variables (values redacted):%s\n' "$proxy_names"
  else
    printf 'Set proxy environment variables: none of HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY\n'
  fi
}

report_openwork() {
  section "OPENWORK"
  if [ -z "$HOME" ]; then
    printf 'HOME: not set; skipping user config files.\n'
  else
    env_json="$HOME/.config/openwork/env.json"
    bootstrap_json="$HOME/.config/openwork/desktop-bootstrap.json"

    if [ -f "$env_json" ]; then
      printf '%s: present\n' "$env_json"
      if [ -r "$env_json" ] && command_exists grep; then
        if grep -q '"NODE_EXTRA_CA_CERTS"' "$env_json" 2>/dev/null; then
          printf '%s NODE_EXTRA_CA_CERTS key: present\n' "$env_json"
        else
          printf '%s NODE_EXTRA_CA_CERTS key: absent\n' "$env_json"
        fi
      elif [ ! -r "$env_json" ]; then
        printf '%s NODE_EXTRA_CA_CERTS key: unavailable (file not readable)\n' "$env_json"
      else
        printf '%s NODE_EXTRA_CA_CERTS key: unavailable (grep tool not available)\n' "$env_json"
      fi
    else
      printf '%s: absent\n' "$env_json"
    fi

    if [ -f "$bootstrap_json" ]; then
      printf '%s: present\n' "$bootstrap_json"
      if [ -r "$bootstrap_json" ] && command_exists grep; then
        if grep -q '"enterpriseActivation"' "$bootstrap_json" 2>/dev/null; then
          printf '%s enterpriseActivation key: present\n' "$bootstrap_json"
        else
          printf '%s enterpriseActivation key: absent\n' "$bootstrap_json"
        fi
      elif [ ! -r "$bootstrap_json" ]; then
        printf '%s enterpriseActivation key: unavailable (file not readable)\n' "$bootstrap_json"
      else
        printf '%s enterpriseActivation key: unavailable (grep tool not available)\n' "$bootstrap_json"
      fi
    else
      printf '%s: absent\n' "$bootstrap_json"
    fi
  fi

  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    if command_exists defaults; then
      app_version="$(defaults read /Applications/OpenWork.app/Contents/Info CFBundleShortVersionString 2>/dev/null)"
      if [ -n "$app_version" ]; then
        printf '/Applications/OpenWork.app version: %s\n' "$app_version"
      else
        printf '/Applications/OpenWork.app version: unavailable\n'
      fi
    else
      printf 'defaults: tool not available\n'
    fi
  else
    printf 'OpenWork app version: best-effort defaults read is macOS-only\n'
  fi
}

report_engine_log() {
  section "ENGINE LOG"
  log_dir="$HOME/.local/share/opencode/log"
  if [ -z "$HOME" ]; then
    printf 'HOME: not set; skipping engine logs.\n'
  elif [ ! -d "$log_dir" ]; then
    printf '%s: absent\n' "$log_dir"
  elif ! command_exists ls; then
    printf 'ls: tool not available\n'
  elif ! command_exists sed; then
    printf 'sed: tool not available\n'
  elif ! command_exists grep; then
    printf 'grep: tool not available\n'
  elif ! command_exists tail; then
    printf 'tail: tool not available\n'
  else
    # shellcheck disable=SC2012
    log_files="$(ls -t "$log_dir"/* 2>/dev/null | sed -n '1,3p')"
    if [ -z "$log_files" ]; then
      printf 'No log files found in %s.\n' "$log_dir"
    else
      inspected_count="0"
      while IFS= read -r unused_log_file; do
        if [ -n "$unused_log_file" ]; then
          inspected_count=$((inspected_count + 1))
        fi
      done <<EOF
$log_files
EOF
      printf 'Newest log files inspected: %s\n' "$inspected_count"
      log_matches="$(
        while IFS= read -r log_file; do
          if [ -f "$log_file" ]; then
            grep -i 'openwork-cloud\|SSE error' "$log_file" 2>/dev/null | while IFS= read -r log_line; do
              printf '%s: %s\n' "${log_file##*/}" "$(compact_log_line "$log_line")"
            done
          fi
        done <<EOF
$log_files
EOF
      )"
      log_matches="$(printf '%s\n' "$log_matches" | tail -n 10)"
      if [ -n "$log_matches" ]; then
        printf 'Last 10 matching lines (secrets redacted where recognizable; long lines truncated):\n'
        print_block "$log_matches"
      else
        printf 'No matching lines found for openwork-cloud or SSE error.\n'
      fi
    fi
  fi

  printf 'Decoder: "typo in the url or port?" = DNS; "unable to connect" = firewall; "unable to verify the first certificate"/"self signed certificate" = trust/chain; repeated 5xx = upstream proxy.\n'
}

if [ -z "${1:-}" ]; then
  printf 'Usage: %s <host> [port]\n' "${0##*/}"
  printf 'Example: %s openwork-poc.example.com 443\n' "${0##*/}"
  exit 0
fi

TARGET_HOST="$(normalize_host "$1")"
TARGET_PORT="${2:-443}"

printf 'OpenWork Network Doctor %s (macOS/Linux)\n' "$SCRIPT_VERSION"
printf 'Read-only report. Secret values are not printed. Safe to paste into a support thread.\n'
printf 'Target: %s:%s\n' "$TARGET_HOST" "$TARGET_PORT"

report_system
report_dns
report_tcp
report_tls_chain
report_trust_environment
report_proxy
report_openwork
report_engine_log

printf '\n===== COPY EVERYTHING ABOVE THIS LINE =====\n'
exit 0

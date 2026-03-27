#!/usr/bin/env bash
# Refresh Claude Code OAuth token if within 10 minutes of expiry.
# Safe to run from cron every minute.
set -euo pipefail

CREDS="$HOME/.claude/.credentials.json"
LOCK="$HOME/.claude/.token-refresh.lock"

expires_at_ms=$(python3 -c "import json; d=json.load(open('$CREDS')); print(d['claudeAiOauth']['expiresAt'])" \
    2>/dev/null) || { echo "ERROR: Could not read credentials" >&2; exit 1; }

now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
(( (expires_at_ms - now_ms) / 1000 > 600 )) && exit 0

if [[ -f "$LOCK" ]]; then
    lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCK") ))
    (( lock_age < 60 )) && exit 0
    rm -f "$LOCK"
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

refresh_token=$(python3 -c "import json; d=json.load(open('$CREDS')); print(d['claudeAiOauth']['refreshToken'])" \
    2>/dev/null) || { echo "ERROR: Could not read refresh token" >&2; exit 1; }

request_body=$(python3 -c "
import json, sys
print(json.dumps({
    'grant_type': 'refresh_token',
    'refresh_token': sys.argv[1],
    'client_id': '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    'scope': 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
}))
" "$refresh_token") || { echo "ERROR: Could not build request body" >&2; exit 1; }

response=$(curl -sf -X POST https://platform.claude.com/v1/oauth/token \
    -H "Content-Type: application/json" \
    -d "$request_body") || { echo "ERROR: curl request failed" >&2; exit 1; }

# Parse response and update credentials
python3 -c "
import json, sys, time

resp = json.loads(sys.argv[1])
creds_path = sys.argv[2]

if 'access_token' not in resp:
    print('ERROR: No access_token in response: ' + sys.argv[1][:200], file=sys.stderr)
    sys.exit(1)

expires_in = resp.get('expires_in', 3600)
expires_at_ms = int(time.time() * 1000) + expires_in * 1000
hours = expires_in // 3600

with open(creds_path, 'r') as f:
    creds = json.load(f)

creds['claudeAiOauth']['accessToken'] = resp['access_token']
if 'refresh_token' in resp:
    creds['claudeAiOauth']['refreshToken'] = resp['refresh_token']
creds['claudeAiOauth']['expiresAt'] = expires_at_ms

with open(creds_path, 'w') as f:
    json.dump(creds, f, indent=2)

print(f'Token refreshed, expires in {hours}h', file=sys.stderr)
" "$response" "$CREDS" || exit 1

chmod 640 "$CREDS"

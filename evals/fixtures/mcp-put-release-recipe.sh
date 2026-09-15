set -euo pipefail
body=$(jq -cn --arg name "$MCP_NAME" --arg url "$MCP_URL" '{name:$name,url:$url,authType:"none",credentialMode:"shared",exposeDirectly:false,access:{orgWide:true,memberIds:[],teamIds:[]}}')
curl --proto '=https' --fail-with-body -sS -X PUT -H "x-api-key: $DEN_API_KEY" -H 'Content-Type: application/json' --data-binary "$body" "$DEN_API_URL/v1/mcp-connections/by-key/platform-tools" | jq '{id,externalKey,updatedAt,reconnectionRequired}'

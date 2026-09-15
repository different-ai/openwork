#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
: "${DEN_API_URL:?Set DEN_API_URL}"
: "${DEN_API_KEY:?Set DEN_API_KEY}"
: "${PROOF_PRIVATE_DIR:?Set an existing private output directory}"
: "${STUB_URL:?Set the synthetic HTTPS witness origin}"
[[ -d "$PROOF_PRIVATE_DIR" ]]
case "$DEN_API_URL" in
  https://*|http://localhost:*|http://127.0.0.1:*) ;;
  *) exit 2 ;;
esac
MODE=${1:-apply}
RUN_LABEL=${2:-run1}
[[ "$RUN_LABEL" =~ ^[a-zA-Z0-9_-]+$ ]]
case "$RUN_LABEL" in
  run1) UPSERT_STATUS=201 ;;
  run2) UPSERT_STATUS=200 ;;
  *) exit 2 ;;
esac
CURL_CONFIG="$PROOF_PRIVATE_DIR/job-curl.config"
printf 'header = "x-api-key: %s"\nheader = "Content-Type: application/json"\n' "$DEN_API_KEY" > "$CURL_CONFIG"

request() {
  local label=$1 category=$2 method=$3 path=$4 body=${5:-null} expected=${6:-200} stem curl_exit=0
  case "$category" in
    preflight|read|setup|cleanup) [[ "$expected" == 200 ]] ;;
    diagnostic)
      if [[ "$expected" == 404 ]]; then
        [[ "$method" == GET && ( "$path" == /v1/members || "$path" == /v1/teams ) ]]
      else
        [[ "$expected" == 200 ]]
      fi ;;
    convergent) [[ "$expected" == 200 || ( "$method" == PUT && "$expected" == 201 ) ]] ;;
    lifecycle) [[ ( "$method" == DELETE && "$expected" == 200 ) || ( "$method" == PUT && "$expected" == 201 ) ]] ;;
    *) return 2 ;;
  esac
  stem="$PROOF_PRIVATE_DIR/job-$label"
  [[ ! -e "$stem.json" ]]
  printf '%s' "$body" > "$stem.input"
  local args=(--silent --show-error --max-time 100 --config "$CURL_CONFIG" -X "$method" -D "$stem.headers" -o "$stem.body" -w '%{http_code}')
  if [[ "$body" != null ]]; then args+=(--data-binary "@$stem.input"); fi
  STATUS=$(curl "${args[@]}" "$DEN_API_URL$path" 2> "$stem.stderr") || curl_exit=$?
  BODY_FILE="$stem.body"
  [[ -e "$BODY_FILE" ]] || printf '' > "$BODY_FILE"
  [[ -e "$stem.headers" ]] || printf '' > "$stem.headers"
  STATUS=${STATUS:-000}
  jq -n --arg label "$label" --arg category "$category" --arg method "$method" --arg url "$DEN_API_URL$path" --slurpfile body "$stem.input" --rawfile response "$stem.body" --rawfile headers "$stem.headers" --rawfile stderr "$stem.stderr" --argjson status "$((10#$STATUS))" --argjson expectedStatus "$expected" --argjson curlExit "$curl_exit" '{label:$label,category:$category,expectedStatus:$expectedStatus,request:{method:$method,url:$url,headers:{"x-api-key":env.DEN_API_KEY,"Content-Type":"application/json"},body:$body[0]},response:{status:$status,headers:$headers,body:($response|try fromjson catch $response)},curlExit:$curlExit,stderr:$stderr}' > "$stem.json"
  printf '%s %s\n' "$label" "$STATUS"
  if [[ "$curl_exit" != 0 ]]; then
    printf '%s: curl failed (%s)\n' "$label" "$curl_exit" >&2
    return "$curl_exit"
  fi
  if [[ "$STATUS" != "$expected" ]]; then
    printf '%s: unexpected HTTP %s, expected %s\n' "$label" "$STATUS" "$expected" >&2
    return 22
  fi
  if [[ "$category" == cleanup ]]; then jq -e '.ok == true' "$BODY_FILE" > /dev/null; fi
}

snapshot() {
  local prefix=$1 providers teams mcps policies marketplaces
  request "$prefix-snapshot-providers" read GET '/v1/llm-providers?scope=manageable'
  providers=$(jq -ce '[.llmProviders[].id]|sort' "$BODY_FILE")
  request "$prefix-snapshot-teams-contract" diagnostic GET '/v1/teams' null 404
  request "$prefix-snapshot-org-teams" read GET '/v1/org'
  teams=$(jq -ce '[.teams[].id]|sort' "$BODY_FILE")
  request "$prefix-snapshot-mcp" read GET '/v1/mcp-connections?scope=manageable'
  mcps=$(jq -ce '[.connections[].id]|sort' "$BODY_FILE")
  request "$prefix-snapshot-policies" read GET '/v1/desktop-policies'
  policies=$(jq -ce '[.desktopPolicies[].id]|sort' "$BODY_FILE")
  request "$prefix-snapshot-marketplaces" read GET '/v1/marketplaces'
  marketplaces=$(jq -ce '[.items[].id]|sort' "$BODY_FILE")
  jq -n --argjson providers "$providers" --argjson teams "$teams" --argjson mcps "$mcps" --argjson policies "$policies" --argjson marketplaces "$marketplaces" '{providers:$providers,teams:$teams,mcpConnections:$mcps,desktopPolicies:$policies,marketplaces:$marketplaces}|with_entries(.value={count:(.value|length),ids:.value})' > "$PROOF_PRIVATE_DIR/snapshot-$prefix.json"
}

if [[ "$MODE" == prepare ]]; then
  body=$(jq -cn --arg url "$STUB_URL/public" '{name:"Lane3 existing MCP",url:$url,authType:"none",credentialMode:"shared",exposeDirectly:false,access:{orgWide:true,memberIds:[],teamIds:[]}}')
  request setup-unkeyed-create setup POST /v1/mcp-connections "$body"
  [[ "$STATUS" == 200 ]]
  jq -e '{id,updatedAt,externalKey}|select(.externalKey==null)' "$BODY_FILE" > "$PROOF_PRIVATE_DIR/unkeyed-state.json"
  exit 0
fi

if [[ "$MODE" == lifecycle ]]; then
  request lifecycle-marketplace-before read GET '/v1/marketplaces/by-key/lane3-marketplace'
  previous_id=$(jq -er '.item.id | strings | select(length>0)' "$BODY_FILE")
  request lifecycle-marketplace-delete lifecycle DELETE '/v1/marketplaces/by-key/lane3-marketplace'
  jq -e '.ok == true and .deleted == true' "$BODY_FILE" > /dev/null
  request lifecycle-marketplace-recreate lifecycle PUT '/v1/marketplaces/by-key/lane3-marketplace' '{"name":"Lane3 marketplace","description":"Synthetic post-deploy proof","logoUrl":null}' 201
  recreated_id=$(jq -er '.item.id | strings | select(length>0)' "$BODY_FILE")
  [[ "$recreated_id" != "$previous_id" ]]
  request lifecycle-marketplace-after read GET '/v1/marketplaces/by-key/lane3-marketplace'
  jq -e --arg id "$recreated_id" '.item.id == $id' "$BODY_FILE" > /dev/null
  exit 0
fi

if [[ "$MODE" == cleanup ]]; then
  request cleanup-oauth cleanup DELETE '/v1/mcp-connections/by-key/lane3-oauth'
  unkeyed=$(jq -er .id "$PROOF_PRIVATE_DIR/unkeyed-state.json")
  request cleanup-unkeyed cleanup DELETE "/v1/mcp-connections/$unkeyed"
  request cleanup-provider cleanup DELETE '/v1/llm-providers/by-key/lane3-provider'
  request cleanup-policy cleanup DELETE '/v1/desktop-policies/by-key/lane3-policy'
  request cleanup-marketplace cleanup DELETE '/v1/marketplaces/by-key/lane3-marketplace'
  request cleanup-team cleanup DELETE '/v1/teams/by-key/lane3-team'
  snapshot cleanup
  exit 0
fi

[[ "$MODE" == apply ]]
: "${LLM_API_KEY:?Set the synthetic provider credential}"
: "${MEMBER_EMAIL:?Set the member email to resolve}"
request "$RUN_LABEL-openapi" preflight GET /openapi.json
jq -e '.paths["/v1/mcp-connections/by-key/{externalKey}"].put != null' "$BODY_FILE" > /dev/null
printf 'OpenAPI info.version=%s\n' "$(jq -r .info.version "$BODY_FILE")"

body=$(jq -cn --arg api "$STUB_URL/v1" '{name:"Lane3 OpenAI-compatible",source:"custom",credentialMode:"shared",apiKey:env.LLM_API_KEY,allMembers:true,memberIds:[],teamIds:[],customConfig:{id:"lane3-provider",name:"Lane3 OpenAI-compatible",npm:"@ai-sdk/openai-compatible",env:["LANE3_PROVIDER_API_KEY"],api:$api,models:[{id:"lane3-model",name:"Lane3 model",attachment:false,reasoning:false,tool_call:true,structured_output:false,temperature:true,limit:{context:4096,input:4096,output:16},modalities:{input:["text"],output:["text"]}}]}}')
request "$RUN_LABEL-provider-put" convergent PUT /v1/llm-providers/by-key/lane3-provider "$body" "$UPSERT_STATUS"
provider=$(jq -er '.llmProvider.id' "$BODY_FILE")
request "$RUN_LABEL-provider-connect" diagnostic GET "/v1/llm-providers/$provider/connect"
jq -e '.llmProvider | select((.apiKey|type)=="string" and (.apiKey|length)>0) | {api:.providerConfig.api,apiKey,modelIds:["lane3-model"]}' "$BODY_FILE" > "$PROOF_PRIVATE_DIR/$RUN_LABEL-provider-probe.input"
request "$RUN_LABEL-provider-usability" diagnostic POST /v1/llm-providers/test-connection "$(jq -c . "$PROOF_PRIVATE_DIR/$RUN_LABEL-provider-probe.input")"
jq -e '.result.ok == true and .result.status == 200 and (.verifications|type)=="array" and (.verifications|length)==1 and (.verifications|all(.id=="lane3-model" and .status=="ok"))' "$BODY_FILE" > /dev/null
request "$RUN_LABEL-org-patch" convergent PATCH /v1/org '{"requireSso":false}'
request "$RUN_LABEL-members-contract" diagnostic GET /v1/members null 404
request "$RUN_LABEL-members-org" read GET /v1/org
member=$(jq -er '[.members[]|select(.user.email==env.MEMBER_EMAIL)|.id]|if length==1 then .[0] else error("Expected exactly one member") end' "$BODY_FILE")
body=$(jq -cn --arg member "$member" '{name:"Lane3 team",memberIds:[$member],grantsOrganizationAdmin:false}')
request "$RUN_LABEL-team-put" convergent PUT /v1/teams/by-key/lane3-team "$body" "$UPSERT_STATUS"
team=$(jq -er '.team.id' "$BODY_FILE")

unkeyed=$(jq -er .id "$PROOF_PRIVATE_DIR/unkeyed-state.json")
request "$RUN_LABEL-unkeyed-get" read GET "/v1/mcp-connections/$unkeyed"
body=$(jq -ce '{expectedUpdatedAt:.updatedAt,name:"Lane3 managed existing MCP",url,authType,credentialMode,exposeDirectly,access}' "$BODY_FILE")
request "$RUN_LABEL-unkeyed-put" convergent PUT "/v1/mcp-connections/$unkeyed" "$body"
body=$(jq -cn --arg url "$STUB_URL/oauth/mcp" --arg issuer "$STUB_URL" --arg team "$team" '{name:"Lane3 OAuth MCP",url:$url,authType:"oauth",credentialMode:"shared",exposeDirectly:false,access:{orgWide:false,memberIds:[],teamIds:[$team]},oauthClient:{clientId:"lane3-client",tokenEndpointAuthMethod:"client_secret_post"},authorizationServerIssuer:$issuer,requestedScopes:["lane3.read"]}|if env.OMIT_OAUTH_CLIENT_SECRET=="1" then . else .oauthClient.clientSecret=env.OAUTH_CLIENT_SECRET end')
request "$RUN_LABEL-oauth-put" convergent PUT /v1/mcp-connections/by-key/lane3-oauth "$body" "$UPSERT_STATUS"
jq -e '{id,updatedAt}' "$BODY_FILE" > "$PROOF_PRIVATE_DIR/$RUN_LABEL-oauth-state.json"

body=$(jq -cn --arg team "$team" --arg origin "$STUB_URL" '{policyName:"Lane3 explicit policy",priority:10,isEnabled:true,memberIds:[],teamIds:[$team],roles:[],policy:{access:{mode:"custom",capabilities:{allowCustomProviders:true,allowZenModel:false,allowMultipleWorkspaces:false,allowControlSettings:true,allowManageExtensions:true,allowBuiltInExtensions:true,allowAlphaUpdates:false,showWelcomePage:false}},execution:{commands:"deny",blockedCommands:["rm -rf"],browserOrigins:[$origin],blockBrowserUploads:true}}}')
request "$RUN_LABEL-policy-put" convergent PUT /v1/desktop-policies/by-key/lane3-policy "$body" "$UPSERT_STATUS"
request "$RUN_LABEL-marketplace-put" convergent PUT /v1/marketplaces/by-key/lane3-marketplace '{"name":"Lane3 marketplace","description":"Synthetic post-deploy proof","logoUrl":null}' "$UPSERT_STATUS"
snapshot "$RUN_LABEL"
jq -s '[.[]|select(.category=="convergent")|{label,status:.response.status}]' "$PROOF_PRIVATE_DIR"/job-"$RUN_LABEL"-*.json > "$PROOF_PRIVATE_DIR/$RUN_LABEL-convergent-statuses.json"
exit 0

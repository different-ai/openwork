export const evidenceAssetNames = [
  "step-01-setup.png",
  "step-02-network-failure.png",
  "step-03-oauth-callback.png",
  "step-04-oauth-connected.png",
  "step-05-catalog-test.png",
  "step-06-version-fault.png",
  "step-07-catalog-repaired.png",
  "step-08-provider-denial.png",
  "step-09-cleanup.png",
] as const

export type EvidenceAssetName = (typeof evidenceAssetNames)[number]

export type ProofFrame = {
  id: string
  asset: EvidenceAssetName
  title: string
  alt: string
  caption: string
  lookFor: readonly string[]
}

export type ProofChapter = {
  id: string
  label: string
  level: "Environment" | "Level 1" | "Level 2" | "Level 3" | "Integration"
  title: string
  summary: string
  operatorAction: string
  visibleProof: readonly string[]
  machineProof: readonly string[]
  failureFound: string
  resolution: string
  blocker:
    | "High blocker · closed in rehearsal"
    | "Medium blocker · closed in rehearsal"
    | "Verification boundary"
  source: {
    label: string
    url: string
    revision: string
  } | null
  frames: readonly ProofFrame[]
  apiEvidence?: readonly string[]
  limitation?: string
}

export const proofMetadata = {
  branch: "feature/mcp-diagnostics-integration-rehearsal",
  baselineHead: "b44089ce",
  baselineRun: "2026-07-11T21-25-52-239Z",
  automatedResult: "272 tests · 1,443 expectations",
  browserResult: "8 operational chapters · 66 assertions · 9 evidence frames",
  rehearsalPr: {
    label: "Independent rehearsal #2675",
    url: "https://github.com/different-ai/openwork/pull/2675",
  },
  parentPr: {
    label: "Controlled release ledger #2674",
    url: "https://github.com/different-ai/openwork/pull/2674",
  },
} as const

export const releaseStatus = [
  {
    id: "agent",
    label: "Agent verified",
    value: "Passed",
    tone: "positive",
    detail: "The independent rehearsal and its focused automated checks passed.",
  },
  {
    id: "jalil",
    label: "Jalil verification",
    value: "Not started",
    tone: "neutral",
    detail: "Viewing this tour does not record approval or change the release ledger.",
  },
  {
    id: "parent",
    label: "Controlled parent",
    value: "None integrated",
    tone: "neutral",
    detail: "No source level has been accepted into the controlled release branch.",
  },
] as const

export const proofBoundaries = {
  proves: [
    "OpenWork can name the first owned connection failure instead of surfacing an opaque SDK error.",
    "A deterministic ServiceNow-style, pre-registered confidential OAuth ceremony works through Den's real callback path.",
    "The focused mock suite also exercises Microsoft enterprise profiles for Work IQ and Agent 365; the screenshot tour deliberately uses one ServiceNow-style journey.",
    "The read-only connection test initializes MCP, exhausts the bounded paginated catalog, and closes its session without invoking a tool.",
    "Live diagnostics preserve the highest proven phase, support repair and retry, and keep provider-operation health separate from connection health.",
  ],
  doesNotProve: [
    "Conformance with a live Microsoft 365 or ServiceNow customer tenant.",
    "Provider writes or mutations; the only executed operation is one bounded synthetic read.",
    "Seamless transfer of an in-flight OAuth attempt across a Den restart or instance hop.",
    "Forced cancellation inside every already-running third-party SDK promise.",
  ],
} as const

export const replayCommands = [
  {
    label: "Start this proof viewer",
    command: "pnpm dev:mcp-diagnostics-proof",
  },
  {
    label: "Validate its evidence contract",
    command: "pnpm --filter @openwork/mcp-diagnostics-proof test",
  },
  {
    label: "Typecheck and build",
    command:
      "pnpm --filter @openwork/mcp-diagnostics-proof typecheck && pnpm --filter @openwork/mcp-diagnostics-proof build",
  },
  {
    label: "Replay the underlying product journey",
    command:
      "MCP_MOCK_DIAGNOSTICS_KEY=rehearsal-key pnpm fraimz --flow mcp-diagnostics-integration-rehearsal --cdp-url <chrome-cdp-url>",
  },
  {
    label: "Prove this viewer in a browser",
    command:
      "MCP_DIAGNOSTICS_PROOF_URL=http://127.0.0.1:3334 pnpm fraimz --flow mcp-diagnostics-proof-app --cdp-url <chrome-cdp-url>",
  },
] as const

export const chapters: readonly ProofChapter[] = [
  {
    id: "setup",
    label: "Setup",
    level: "Environment",
    title: "Start from a controlled enterprise-style fixture",
    summary:
      "The rehearsal begins with an isolated Den, a deterministic ServiceNow-style MCP fixture, and synthetic owner credentials. The healthy starting contract is checked before any failure is introduced.",
    operatorAction:
      "Start the isolated Den and protected mock, confirm its health contract, then sign in as the seeded organization owner.",
    visibleProof: [
      "The Connections screen is available in the isolated Den.",
      "Exactly one deliberate unreachable rehearsal row is present; stale rehearsal rows were removed first.",
      "The operator begins from an ordinary administration surface, not a test-only UI.",
    ],
    machineProof: [
      "The fixture reports the ServiceNow profile with pre_registered OAuth and client_secret_post.",
      "Connection and operation fault controls both start at none.",
      "A stable MCP protocol revision is advertised and the seeded owner can sign in.",
    ],
    failureFound:
      "A visually healthy demo could previously begin from the wrong mock mode and never exercise enterprise confidential-client behavior.",
    resolution:
      "The replay now gates setup on an explicit fixture contract and a protected diagnostics key before it creates any connection.",
    blocker: "High blocker · closed in rehearsal",
    source: null,
    frames: [
      {
        id: "setup-ready",
        asset: "step-01-setup.png",
        title: "The isolated environment is ready",
        alt: "OpenWork Den Connections screen at the beginning of the isolated MCP diagnostics rehearsal.",
        caption:
          "This is the controlled starting point. Machine assertions beside the frame prove the mock profile and security posture that are not visible in the screenshot itself.",
        lookFor: ["Connections administration", "No real customer tenant", "Synthetic rehearsal context"],
      },
    ],
    limitation:
      "The fixture is intentionally synthetic. It exercises the OpenWork ceremony without claiming provider-tenant conformance.",
  },
  {
    id: "network-failure",
    label: "Step 1",
    level: "Level 1",
    title: "Turn an opaque network error into an owned action",
    summary:
      "A deliberately unreachable endpoint fails at Network TCP. The UI names the responsible owner and next action while retaining only support-safe evidence.",
    operatorAction: "Select Diagnose on the unreachable connection and run the diagnostic.",
    visibleProof: [
      "Network TCP is the first failure.",
      "Network Admin owns the repair.",
      "The suggested action is to check the provider allowlist and listener.",
      "No generic fetch failed message is shown.",
    ],
    machineProof: [
      "The timeline retains a safe ECONNREFUSED-style reference for correlation.",
      "Credentials, bearer tokens, MCP session identifiers, provider payloads, and stack traces are absent.",
    ],
    failureFound:
      "Raw fetch and SDK failures gave administrators no reliable phase, owner, or safe remediation path.",
    resolution:
      "Structured diagnostic errors now preserve causal phase and safe reference metadata while mapping the failure to an operational owner.",
    blocker: "High blocker · closed in rehearsal",
    source: {
      label: "Structured diagnostics #2669",
      url: "https://github.com/different-ai/openwork/pull/2669",
      revision: "source head 7b99407c",
    },
    frames: [
      {
        id: "network-tcp",
        asset: "step-02-network-failure.png",
        title: "The first failure is named and assigned",
        alt: "MCP diagnostic dialog showing Network TCP as the first failure and Network Admin as owner.",
        caption:
          "The visible outcome is actionable: one phase, one owner, one remediation, and strictly redacted support evidence.",
        lookFor: ["Network Tcp", "Owner: Network Admin", "Support evidence is strictly redacted"],
      },
    ],
  },
  {
    id: "enterprise-oauth",
    label: "Step 2",
    level: "Level 2",
    title: "Complete realistic pre-registered confidential OAuth",
    summary:
      "The same Connections UI configures a ServiceNow-style provider app, displays the exact Den callback, and becomes Connected only after the token exchange and MCP validation succeed.",
    operatorAction:
      "Create one organization connection, enter the pre-registered client credentials, register the displayed callback with the fixture, and authorize from the exact connection row.",
    visibleProof: [
      "The callback is bound to the Den API and the specific connection.",
      "The ordinary connection row reaches Connected after the callback completes.",
      "Test connection and Diagnose are available from the durable row.",
    ],
    machineProof: [
      "The callback has no query credential and the client secret is never rendered back into the dashboard.",
      "The browser uses client_secret_post and never calls dynamic client registration.",
      "Credential and Connected state persist only after token acquisition and MCP initialization succeed.",
    ],
    failureFound:
      "A convenient dynamic-registration path could pass locally while the enterprise pre-registration path, callback origin, or post-callback refresh was broken.",
    resolution:
      "The fixture now supports exact callback replacement and production-style confidential token exchange; the UI refreshes the saved connection after callback completion.",
    blocker: "High blocker · closed in rehearsal",
    source: {
      label: "Enterprise mock and test #2670",
      url: "https://github.com/different-ai/openwork/pull/2670",
      revision: "source head e1569ec3",
    },
    frames: [
      {
        id: "oauth-callback",
        asset: "step-03-oauth-callback.png",
        title: "OpenWork exposes the exact callback",
        alt: "OpenWork connection form showing the exact Den callback for a pre-registered enterprise OAuth app.",
        caption:
          "Configuration is stored so the callback can be registered, but provider credentials and Connected state are not accepted yet.",
        lookFor: ["Exact redirect URL", "Connection-bound callback", "No query credential"],
      },
      {
        id: "oauth-connected",
        asset: "step-04-oauth-connected.png",
        title: "The validated connection becomes durable",
        alt: "ServiceNow-style MCP connection row showing Connected after confidential OAuth and MCP initialization.",
        caption:
          "Only after the confidential token exchange and MCP handshake succeed does the ordinary row show Connected.",
        lookFor: ["Connected", "Test connection", "Diagnose"],
      },
    ],
    limitation:
      "This proves OpenWork's ceremony against a deterministic ServiceNow-shaped contract, not a live customer instance.",
  },
  {
    id: "catalog-test",
    label: "Step 3",
    level: "Level 2",
    title: "Test protocol and the complete catalog without invoking a tool",
    summary:
      "The read-only connection test initializes MCP, sends the initialized notification, follows every bounded tools/list page, and shuts down the session.",
    operatorAction: "Select Test connection on the connected ServiceNow-style row.",
    visibleProof: [
      "Protocol 2025-06-18 is ready.",
      "All four fixture tools are discovered across two pages.",
      "The stable read-only operation appears in the catalog.",
    ],
    machineProof: [
      "No tools/call request occurs during the connection test.",
      "The initialized notification and session shutdown complete.",
      "The provider-operation fault is still disabled at this checkpoint.",
    ],
    failureFound:
      "A single-page or initialize-only check could claim health while later catalog pages or teardown were broken.",
    resolution:
      "Test connection now proves the complete bounded catalog and cleanup while remaining operation-free.",
    blocker: "Medium blocker · closed in rehearsal",
    source: {
      label: "Enterprise mock and test #2670",
      url: "https://github.com/different-ai/openwork/pull/2670",
      revision: "source head e1569ec3",
    },
    frames: [
      {
        id: "catalog-read-only",
        asset: "step-05-catalog-test.png",
        title: "The complete bounded catalog is visible",
        alt: "Read-only MCP connection test showing protocol 2025-06-18, four tools, and two pages.",
        caption:
          "This frame proves protocol and catalog readiness. It deliberately does not claim that a provider operation has run.",
        lookFor: ["Protocol ready", "4 tools", "2 pages", "look_up_incident_records"],
      },
    ],
  },
  {
    id: "version-fault",
    label: "Step 4",
    level: "Level 3",
    title: "Watch the first live failure without erasing prior health",
    summary:
      "A controlled version mismatch occurs after authorization. The live timeline preserves Authorized as the highest proven phase and names MCP Version as the first failure.",
    operatorAction: "Enable the version fault, select Diagnose, and watch Den stream the attempt.",
    visibleProof: [
      "Authorized remains proven.",
      "MCP Version is the first failing phase.",
      "Provider Admin owns the repair and receives a specific compatibility action.",
    ],
    machineProof: [
      "The timeline is leased, bounded, reconnectable, and metadata-only.",
      "The version fault is injected only after the earlier OAuth and catalog checkpoints pass.",
    ],
    failureFound:
      "A later protocol failure could previously collapse into a generic connection error and hide that authorization had already succeeded.",
    resolution:
      "Live diagnostic phases retain the highest proven health and identify exactly where the active attempt stopped.",
    blocker: "High blocker · closed in rehearsal",
    source: {
      label: "Live diagnostic tracing #2672",
      url: "https://github.com/different-ai/openwork/pull/2672",
      revision: "source head 3e84bd30",
    },
    frames: [
      {
        id: "mcp-version",
        asset: "step-06-version-fault.png",
        title: "Authorized is preserved when MCP Version fails",
        alt: "Live MCP diagnostic timeline preserving Authorized and showing MCP Version as the first failure.",
        caption:
          "The panel separates what is known healthy from the first unhealthy phase, making ownership and remediation clear.",
        lookFor: ["Authorized", "Mcp Version", "Owner: Provider Admin"],
      },
    ],
  },
  {
    id: "catalog-repaired",
    label: "Step 5",
    level: "Level 3",
    title: "Repair and retry to an honest Catalog Ready state",
    summary:
      "After the fixture is repaired, retrying the same diagnostic reaches Catalog Ready and removes the first-failure marker.",
    operatorAction: "Restore the stable protocol version and select Retry in the existing diagnostic panel.",
    visibleProof: [
      "The same attempt surface reaches Catalog Ready.",
      "The complete tool catalog is available.",
      "A prominent boundary says provider operations and mutations were not tested.",
    ],
    machineProof: [
      "No first failing phase remains after retry.",
      "The repaired run uses the same bounded, redacted diagnostic lifecycle.",
    ],
    failureFound:
      "Catalog Ready could be misunderstood as proof that every provider operation or mutation works.",
    resolution:
      "The product now states the scope of readiness next to the success result rather than relying on distant explanatory copy.",
    blocker: "Medium blocker · closed in rehearsal",
    source: {
      label: "Live diagnostic tracing #2672",
      url: "https://github.com/different-ai/openwork/pull/2672",
      revision: "source head 3e84bd30",
    },
    frames: [
      {
        id: "catalog-ready",
        asset: "step-07-catalog-repaired.png",
        title: "The repair succeeds without overclaiming",
        alt: "MCP diagnostic dialog showing Catalog Ready and its provider-operation scope boundary.",
        caption:
          "Connection and catalog health are now proven. The panel explicitly reserves judgment on provider operations and mutations.",
        lookFor: ["Catalog Ready", "complete tool catalog", "operations and mutations were not tested"],
      },
    ],
    limitation:
      "Catalog readiness is not provider-operation readiness; the final chapter tests that boundary separately.",
  },
  {
    id: "provider-denial",
    label: "Step 6",
    level: "Integration",
    title: "Keep a provider-operation denial separate from connection health",
    summary:
      "Only after Catalog Ready is proven does the replay inject a provider authorization denial and execute one bounded synthetic read through Den.",
    operatorAction:
      "Enable the operation-only provider denial, search for the fixture read capability, then execute it with a one-record limit.",
    visibleProof: [
      "The connection remains Connected and the protocol/catalog result remains ready after the separate operation fails.",
      "The proof viewer labels the screenshot boundary instead of pretending the UI alone witnesses the API denial payload.",
    ],
    machineProof: [
      "search_capabilities finds look_up_incident_records and the fixture contract marks it read-only.",
      "execute_capability returns an operation error while protocol_ready remains true.",
      "The denial is owned by provider_admin and no credential, session ID, provider content, or tool arguments are returned.",
    ],
    apiEvidence: [
      "isError: true",
      "error: provider_error",
      "category: provider_policy_denied",
      "phase: PROVIDER_AUTHORIZATION",
      "highest passed: protocol_ready",
      "action owner: provider_admin",
      "remediation: grant the required provider role, ACL, or application permission",
      "tool: look_up_incident_records",
      "limit: 1",
    ],
    failureFound:
      "Structured provider tool results marked isError could be mistaken for successful MCP calls or incorrectly downgrade a healthy connection.",
    resolution:
      "Den classifies the safe provider result as an operation-level authorization failure while preserving the independently proven MCP health state.",
    blocker: "High blocker · closed in rehearsal",
    source: {
      label: "Independent rehearsal #2675",
      url: "https://github.com/different-ai/openwork/pull/2675",
      revision: "product baseline b44089ce",
    },
    frames: [
      {
        id: "provider-policy",
        asset: "step-08-provider-denial.png",
        title: "Connection health survives an operation denial",
        alt: "ServiceNow-style connection still showing Connected and Protocol ready after a separately asserted provider-operation denial.",
        caption:
          "The screenshot witnesses Connected plus the ready protocol and catalog result. The adjacent machine evidence, not text in this image, is the authoritative witness for the provider_policy_denied API result.",
        lookFor: ["Connected", "Protocol ready", "4 tools across 2 pages"],
      },
    ],
    limitation:
      "The executed read is synthetic and bounded to one record; no provider mutation is attempted.",
  },
  {
    id: "cleanup",
    label: "Cleanup",
    level: "Integration",
    title: "Leave no connection, credential, runner, or diagnostic orphan",
    summary:
      "The replay removes both synthetic connections and returns the fixture controls to their healthy defaults so another reviewer starts cleanly.",
    operatorAction: "Delete the synthetic connections, close active streams, and verify the isolated fixture is reset.",
    visibleProof: [
      "The screenshot returns to the ordinary Connections administration surface with no diagnostic dialog or failure state visible.",
      "The image is a post-cleanup landing view; row deletion and fixture reset are established by the adjacent machine evidence.",
    ],
    machineProof: [
      "Both synthetic connection deletes succeed and their names are absent after refresh.",
      "Connection deletion transactionally removes diagnostic attempts and events.",
      "Active runners are cancelled and cannot recreate orphan state after deletion.",
      "Connection and operation faults are none and the stable protocol version is restored for the next replay.",
    ],
    failureFound:
      "Deleting a connection while diagnostics were starting could previously leave attempts, events, or late runner writes behind.",
    resolution:
      "Deletion and runner cancellation now share lifecycle fences, and regression coverage proves the audit and orphan-prevention behavior.",
    blocker: "High blocker · closed in rehearsal",
    source: {
      label: "Independent rehearsal #2675",
      url: "https://github.com/different-ai/openwork/pull/2675",
      revision: "product baseline b44089ce",
    },
    frames: [
      {
        id: "cleanup-complete",
        asset: "step-09-cleanup.png",
        title: "The post-cleanup administration surface",
        alt: "OpenWork Connections administration page after cleanup, cropped above the saved connection list.",
        caption:
          "This frame shows the post-cleanup administration surface. The adjacent machine assertions, not this crop alone, prove that rehearsal rows are absent and fixture faults are reset.",
        lookFor: ["Connections administration", "No diagnostic dialog", "Post-cleanup landing view"],
      },
    ],
    limitation:
      "Cleanup applies only to the isolated rehearsal state and does not alter the controlled release branch.",
  },
]

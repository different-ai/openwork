export type CapabilitySource = "rest" | "external_mcp" | "marketplace" | "skills"

export type CapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
  /** Path parameter names this tool's `path` template requires, e.g. ["workerId"]. */
  pathParams: string[]
  /** Query parameter names this tool documents, if any. */
  queryParams: string[]
  /** Whether calling this tool requires a JSON `body`. */
  hasBody: boolean
  source?: CapabilitySource
  status?: "needs_connection" | "error" | "needs_install" | "content_not_synced"
  hint?: string
}

export type CapabilityMatchFields = Omit<CapabilityMatch, "score">

export type CapabilitySearchText = {
  name: string
  summary: string
  path?: string
  keywords?: string[]
}

export type CapabilityCandidate<TMatch extends CapabilityMatchFields = CapabilityMatchFields> = {
  match: TMatch
  searchText: CapabilitySearchText
}

export type RankedCapabilityMatch<TMatch extends CapabilityMatchFields = CapabilityMatchFields> = TMatch & {
  score: number
}

export type QueryConcept = {
  original: string
  terms: { factor: number; token: string }[]
}

const FIELD_WEIGHTS = {
  nameExact: 5,
  namePrefix: 3,
  summaryExact: 2,
  keywordExact: 2,
  pathExact: 1,
}

const MAX_SCORE_PER_CONCEPT =
  FIELD_WEIGHTS.nameExact
  + FIELD_WEIGHTS.summaryExact
  + FIELD_WEIGHTS.keywordExact
  + FIELD_WEIGHTS.pathExact

const STOPWORD_SOURCE = [
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "and",
  "or",
  "my",
  "your",
  "our",
  "their",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "we",
  "you",
  "they",
  "it",
  "is",
  "are",
  "be",
  "been",
  "was",
  "do",
  "does",
  "did",
  "done",
  "how",
  "what",
  "which",
  "who",
  "when",
  "where",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "please",
  "want",
  "wants",
  "need",
  "needs",
  "about",
  "into",
  "from",
]

const SYNONYM_GROUP_SOURCE = [
  ["create", "add", "new", "make", "register", "post"],
  ["save", "store", "persist", "record", "write", "remember", "post"],
  ["get", "fetch", "read", "show", "view", "retrieve"],
  ["list", "enumerate", "browse"],
  ["update", "edit", "modify", "change", "rename", "set", "patch", "put"],
  ["delete", "remove", "destroy", "erase", "forget"],
  ["search", "find", "query", "lookup", "discover"],
  ["grant", "allow", "authorize", "share", "assign"],
  ["revoke", "deny", "unshare"],
  ["connect", "link", "attach", "login", "authenticate"],
  ["disconnect", "unlink", "detach", "logout"],
  ["cancel", "abort", "stop"],
  ["organization", "org", "company", "tenant"],
  ["member", "user", "person", "people", "teammate"],
  ["team", "group"],
  ["role", "permission"],
  ["invitation", "invite"],
  ["memory", "note", "fact"],
  ["skill", "playbook", "guide"],
  ["worker", "agent", "bot", "machine"],
  ["credential", "secret", "token", "key"],
  ["connection", "connector", "integration"],
  ["config", "configuration", "setting", "preference"],
  ["plugin", "extension", "addon"],
  ["llm", "model", "ai"],
  ["billing", "payment", "subscription", "invoice"],
  ["repo", "repository", "github"],
  ["auth", "oauth", "sso"],
  ["email", "mail", "gmail"],
  ["heartbeat", "activity", "health"],
]

const STOPWORDS = new Set(STOPWORD_SOURCE.map((word) => normalizeToken(word)))
const SYNONYMS = buildSynonyms()

export function tokenizeText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

export function normalizeToken(token: string): string {
  if (token.length < 4 || /\d/.test(token)) return token

  let normalized = token

  if (normalized.length >= 5 && normalized.endsWith("ies")) {
    normalized = applyIfUseful(normalized, `${normalized.slice(0, -3)}y`)
  }

  if (normalized.length >= 5 && shouldDropEs(normalized)) {
    normalized = applyIfUseful(normalized, normalized.slice(0, -2))
  } else if (
    normalized.length >= 4
    && normalized.endsWith("s")
    && !normalized.endsWith("ss")
    && !normalized.endsWith("us")
    && !normalized.endsWith("is")
  ) {
    normalized = applyIfUseful(normalized, normalized.slice(0, -1))
  }

  if (normalized.length >= 6 && normalized.endsWith("ing")) {
    normalized = applyIfUseful(normalized, undoubleTrailingConsonant(normalized.slice(0, -3)))
  } else if (normalized.length >= 5 && normalized.endsWith("ed")) {
    normalized = applyIfUseful(normalized, undoubleTrailingConsonant(normalized.slice(0, -2)))
  }

  if (normalized.endsWith("e")) {
    normalized = applyIfUseful(normalized, normalized.slice(0, -1))
  }

  return normalized
}

export function parseQuery(query: string): QueryConcept[] {
  const concepts: QueryConcept[] = []
  const seen = new Set<string>()

  for (const token of tokenizeText(query).map((entry) => normalizeToken(entry))) {
    if (STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    concepts.push({
      original: token,
      terms: expandTerms(token),
    })
    if (concepts.length >= 12) break
  }

  return concepts
}

export function rankCapabilities<TMatch extends CapabilityMatchFields>(
  query: string,
  candidates: CapabilityCandidate<TMatch>[],
  opts: { limit?: number } = {},
): RankedCapabilityMatch<TMatch>[] {
  const boundedLimit = boundLimit(opts.limit)
  const concepts = parseQuery(query)
  if (concepts.length === 0 || candidates.length === 0) return []

  const docs = candidates.map((candidate) => ({
    candidate,
    tokens: tokenizeCandidate(candidate.searchText),
  }))
  const documentFrequency = buildDocumentFrequency(concepts, docs)
  const rarityDenominator = concepts.reduce((total, concept) => total + rarity(concept, documentFrequency, docs.length), 0)
  if (rarityDenominator === 0) return []

  const ranked = docs
    .map((doc) => {
      const scored = scoreCandidate(doc.tokens, concepts, documentFrequency, docs.length, rarityDenominator)
      if (scored.score <= 0) return null
      return {
        match: doc.candidate.match,
        nameTokenCount: doc.tokens.name.length,
        score: scored.score,
        floorExempt: doc.candidate.match.status === "needs_connection",
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (b.score - a.score) || (a.nameTokenCount - b.nameTokenCount) || a.match.name.localeCompare(b.match.name))

  const aboveFloor = ranked.filter((entry) => entry.score >= 8 || entry.floorExempt)
  const visible = aboveFloor.length > 0 ? aboveFloor : ranked.slice(0, 3)

  return visible.slice(0, boundedLimit).map((entry) => ({
    ...entry.match,
    score: entry.score,
  }))
}

export function buildZeroResultSuggestions(query: string, candidates: CapabilityCandidate[]): string[] {
  const concepts = parseQuery(query)
  if (concepts.length === 0 || candidates.length === 0) return []

  const scored = candidates
    .map((candidate) => {
      const nameTokens = tokenizeText(candidate.searchText.name).map((token) => normalizeToken(token))
      let best = 0
      for (const concept of concepts) {
        for (const token of nameTokens) {
          best = Math.max(best, sharedPrefixLength(concept.original, token))
        }
      }
      return { name: candidate.match.name, score: best }
    })
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))

  return [...new Set(scored.map((entry) => entry.name))].slice(0, 3)
}

function boundLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(20, Math.trunc(limit ?? 5) || 5))
}

function applyIfUseful(original: string, next: string): string {
  return next.length >= 3 ? next : original
}

function shouldDropEs(token: string): boolean {
  return token.endsWith("ses")
    || token.endsWith("xes")
    || token.endsWith("zes")
    || token.endsWith("ches")
    || token.endsWith("shes")
    || token.endsWith("oes")
}

function undoubleTrailingConsonant(token: string): string {
  if (token.length < 2) return token
  const last = token.at(-1)
  const previous = token.at(-2)
  if (!last || last !== previous) return token
  if ("aeiou".includes(last)) return token
  return token.slice(0, -1)
}

function buildSynonyms(): Map<string, string[]> {
  const synonyms = new Map<string, string[]>()
  for (const group of SYNONYM_GROUP_SOURCE) {
    const normalized = [...new Set(group.map((entry) => normalizeToken(entry)))]
    for (const token of normalized) {
      synonyms.set(token, normalized.filter((entry) => entry !== token))
    }
  }
  return synonyms
}

function expandTerms(token: string): { factor: number; token: string }[] {
  const terms = [{ factor: 1, token }]
  for (const synonym of SYNONYMS.get(token) ?? []) {
    terms.push({ factor: 0.7, token: synonym })
  }
  return terms
}

function tokenizeCandidate(searchText: CapabilitySearchText) {
  return {
    name: tokenizeText(searchText.name).map((token) => normalizeToken(token)),
    summary: tokenizeText(searchText.summary).map((token) => normalizeToken(token)),
    path: tokenizeText(searchText.path ?? "").map((token) => normalizeToken(token)),
    keywords: (searchText.keywords ?? []).flatMap((keyword) => tokenizeText(keyword).map((token) => normalizeToken(token))),
  }
}

function buildDocumentFrequency(
  concepts: QueryConcept[],
  docs: { tokens: ReturnType<typeof tokenizeCandidate> }[],
): Map<string, number> {
  const frequency = new Map<string, number>()
  for (const concept of concepts) {
    let count = 0
    for (const doc of docs) {
      const allTokens = new Set([...doc.tokens.name, ...doc.tokens.summary, ...doc.tokens.path, ...doc.tokens.keywords])
      if (allTokens.has(concept.original)) count += 1
    }
    frequency.set(concept.original, count)
  }
  return frequency
}

function rarity(concept: QueryConcept, documentFrequency: Map<string, number>, documentCount: number): number {
  if (documentCount <= 0) return 1
  return Math.max(0.25, 1 - ((documentFrequency.get(concept.original) ?? 0) / documentCount))
}

function scoreCandidate(
  tokens: ReturnType<typeof tokenizeCandidate>,
  concepts: QueryConcept[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  rarityDenominator: number,
): { score: number } {
  let raw = 0
  let matched = 0

  for (const concept of concepts) {
    const conceptScore = scoreConcept(tokens, concept)
    if (conceptScore > 0) matched += 1
    raw += conceptScore * rarity(concept, documentFrequency, documentCount)
  }

  if (matched === 0) return { score: 0 }

  const coverageFactor = 0.3 + (0.7 * (matched / concepts.length))
  const bonus = adjacencyBonus(tokens, concepts) * exactNameBonus(tokens.name, concepts)
  const nameSpecificity = Math.min(1, concepts.length / Math.max(1, tokens.name.length))
  const score = Math.min(100, Math.round((100 * raw * coverageFactor * bonus * nameSpecificity) / (rarityDenominator * MAX_SCORE_PER_CONCEPT)))
  return { score }
}

function scoreConcept(tokens: ReturnType<typeof tokenizeCandidate>, concept: QueryConcept): number {
  let best = 0
  for (const term of concept.terms) {
    const directScore = (
      scoreName(tokens.name, term.token)
      + (tokens.summary.includes(term.token) ? FIELD_WEIGHTS.summaryExact : 0)
      + (tokens.keywords.includes(term.token) ? FIELD_WEIGHTS.keywordExact : 0)
      + (tokens.path.includes(term.token) ? FIELD_WEIGHTS.pathExact : 0)
    )
    best = Math.max(best, directScore * term.factor)
  }
  return best
}

function scoreName(tokens: string[], token: string): number {
  if (tokens.includes(token)) return FIELD_WEIGHTS.nameExact
  return tokens.some((entry) => isBidirectionalPrefix(entry, token)) ? FIELD_WEIGHTS.namePrefix : 0
}

function isBidirectionalPrefix(a: string, b: string): boolean {
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))
}

function adjacencyBonus(tokens: ReturnType<typeof tokenizeCandidate>, concepts: QueryConcept[]): number {
  const originals = concepts.map((concept) => concept.original)
  if (originals.length < 2) return 1

  if (hasOrderedSubsequence(tokens.name, originals) || hasOrderedSubsequence(tokens.summary, originals)) {
    return 1.25
  }
  return hasAdjacentPair(tokens.name, originals) || hasAdjacentPair(tokens.summary, originals) ? 1.1 : 1
}

function exactNameBonus(nameTokens: string[], concepts: QueryConcept[]): number {
  const queryName = concepts.map((concept) => concept.original).join(" ")
  return queryName.length > 0 && queryName === nameTokens.join(" ") ? 1.5 : 1
}

function hasOrderedSubsequence(tokens: string[], queryTokens: string[]): boolean {
  const docTokens = tokens.filter((token) => !STOPWORDS.has(token))
  if (queryTokens.length === 0 || queryTokens.length > docTokens.length) return false
  for (let index = 0; index <= docTokens.length - queryTokens.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < queryTokens.length; offset += 1) {
      if (docTokens[index + offset] !== queryTokens[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

function hasAdjacentPair(tokens: string[], queryTokens: string[]): boolean {
  if (queryTokens.length < 2) return false
  for (let index = 0; index < queryTokens.length - 1; index += 1) {
    if (hasOrderedSubsequence(tokens, [queryTokens[index], queryTokens[index + 1]])) return true
  }
  return false
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

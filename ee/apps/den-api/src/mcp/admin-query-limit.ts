/**
 * Limits on den_query's raw SQL: what a statement may read, and when the
 * database stops it.
 *
 * Reading: den_query runs on Den's own database connection, so the guard
 * below refuses mutations and every table that holds credentials.
 *
 * Time: den_query races a timer in Den, but losing that race does not cancel the
 * statement: MySQL keeps scanning after Den has answered "time limit
 * exceeded", so one unindexed audit query could hold the database for minutes.
 * The limit has to reach the database. MySQL's MAX_EXECUTION_TIME optimizer
 * hint and Vitess's QUERY_TIMEOUT_MS directive both do that for a SELECT, and
 * both must sit directly after the statement's top-level SELECT keyword.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

const FORBIDDEN_SQL =
  /\b(insert|update|delete|drop|alter|create|truncate|rename|replace|grant|revoke|call|load|handler|lock|unlock|set|use|outfile|dumpfile|for\s+update)\b/i

/**
 * Tables whose rows are credentials or carry one: sign-in sessions and the
 * accounts behind them, verification values, device codes, API keys, OAuth
 * clients and tokens, signing keys, invitation links, handoff and worker
 * tokens, and stored connection and provider secrets. Den's own admin tools
 * still count session activity; den_query cannot name these tables at all.
 */
const CREDENTIAL_TABLES = new Set([
  "session", "account", "verification", "devicecode", "apikey", "jwks",
  "oauthclient", "oauthaccesstoken", "oauthrefreshtoken", "oauthconsent",
  "invitation", "desktop_handoff_grant", "worker_token",
  "connected_account", "org_oauth_client", "scim_provider", "organization_diagnostic_credential",
  "llm_provider_member_credential", "inference_keys", "inference_org_upstream_provider_keys",
  "gateway_keys", "gateway_provider_credentials", "gateway_provider_oauth_states",
])

/** Server internals that show other connections' statements, and the values in them, or read the server's files. */
const SERVER_INTERNALS = new Set(["mysql", "sys", "performance_schema", "processlist", "innodb", "innodb_trx", "binlog", "relaylog", "load_file"])

/**
 * The lowercased words a statement names outside its string literals:
 * keywords, identifiers (bare, backticked or double-quoted) and comment text.
 * Refuses syntax that MySQL or Vitess could split differently from this scan,
 * so no table name can hide in what looks like a string here.
 */
function statementWords(sqlText: string): string[] {
  // Whether a backslash escapes a quote depends on the server's SQL mode.
  if (sqlText.includes("\\")) throw new Error("Backslashes are not allowed; write a quote inside text as two quotes ('').")
  let named = ""
  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index]!
    const next = sqlText[index + 1]
    if (char === "'" || char === "\"" || char === "`") {
      let end = index + 1
      for (; end < sqlText.length; end++) {
        if (sqlText[end] !== char) continue
        if (sqlText[end + 1] !== char) break
        end++
      }
      // Single quotes hold data; backticks and (under ANSI_QUOTES) double quotes name things.
      if (char !== "'") named += ` ${sqlText.slice(index + 1, end)} `
      index = end
    } else if (char === "#" || (char === "-" && next === "-") || (char === "/" && next === "*")) {
      const lineComment = char !== "/"
      if (char === "-" && !/^[ \t\r\n]?$/.test(sqlText[index + 2] ?? "")) throw new Error("Write -- only to start a comment, followed by a space.")
      if (!lineComment && sqlText[index + 2] === "!") throw new Error("Executable comments (/*! */) are not allowed.")
      const close = lineComment ? sqlText.indexOf("\n", index) : sqlText.indexOf("*/", index + 2)
      const end = close === -1 ? sqlText.length : lineComment ? close : close + 2
      const comment = sqlText.slice(index, end)
      if (/['"`]/.test(comment)) throw new Error("Comments cannot contain quotes.")
      named += ` ${comment} `
      index = end - 1
    } else {
      named += char
    }
  }
  return Array.from(named.matchAll(/[\w$]+/g), ([word]) => word.toLowerCase())
}

/**
 * The single read-only statement den_query may run, or an error. Besides
 * refusing mutations, it refuses any statement that names a credential table
 * or a server internal, however it is quoted, qualified or aliased.
 */
export function assertReadOnlySql(input: string): string {
  const sqlText = input.trim().replace(/;+\s*$/, "")
  if (sqlText.includes(";")) throw new Error("Only a single SQL statement is allowed")
  if (!/^(select|with|show|describe|explain)\b/i.test(sqlText)) {
    throw new Error("Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed")
  }
  if (FORBIDDEN_SQL.test(sqlText)) {
    throw new Error("Statement contains a forbidden keyword (read-only access)")
  }
  for (const word of statementWords(sqlText)) {
    if (CREDENTIAL_TABLES.has(word)) {
      throw new Error(`den_query cannot read ${word}: it holds credentials. The den_* tools report activity; put text values in single quotes.`)
    }
    if (SERVER_INTERNALS.has(word)) {
      throw new Error(`den_query cannot read ${word}: it can show other connections' statements or the server's files.`)
    }
  }
  return sqlText
}

const TIME_LIMIT_ERROR = /maximum statement execution time exceeded|\b3024\b|query timeout|deadline exceeded/i

/** Whether the database stopped the statement at its time limit (MySQL error 3024 or a Vitess query timeout). */
export function isDatabaseTimeLimitError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record.errno === 3024 || record.code === "ER_QUERY_TIMEOUT") return true
  if (typeof record.message === "string" && TIME_LIMIT_ERROR.test(record.message)) return true
  return isDatabaseTimeLimitError(record.cause, depth + 1)
}

/** The index just past the top-level SELECT keyword, skipping quotes, comments and parentheses. */
function topLevelSelectEnd(sqlText: string): number | null {
  let depth = 0
  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index]!
    const next = sqlText[index + 1]
    if (char === "'" || char === "\"" || char === "`") {
      for (index++; index < sqlText.length; index++) {
        if (sqlText[index] === "\\" && char !== "`") index++
        else if (sqlText[index] === char) {
          if (sqlText[index + 1] === char) index++
          else break
        }
      }
    } else if (char === "/" && next === "*") {
      const end = sqlText.indexOf("*/", index + 2)
      index = end === -1 ? sqlText.length : end + 1
    } else if ((char === "-" && next === "-") || char === "#") {
      const end = sqlText.indexOf("\n", index)
      index = end === -1 ? sqlText.length : end
    } else if (char === "(") {
      depth++
    } else if (char === ")") {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && /[sS]/.test(char)
      && sqlText.slice(index, index + 6).toLowerCase() === "select"
      && !/[\w$]/.test(sqlText[index - 1] ?? "")
      && !/[\w$]/.test(sqlText[index + 6] ?? "")) {
      return index + 6
    }
  }
  return null
}

/**
 * Add the database-side time limit to a statement's top-level SELECT. A WITH
 * statement gets it on the SELECT after its CTEs; EXPLAIN on the statement it
 * explains. SHOW and DESCRIBE have no SELECT and are returned unchanged.
 */
export function withDatabaseTimeLimit(sqlText: string, timeLimitMs: number): string {
  const ms = Math.max(1, Math.floor(timeLimitMs))
  const at = topLevelSelectEnd(sqlText)
  if (at === null) return sqlText
  const rest = sqlText.slice(at)
  const directive = ` /*vt+ QUERY_TIMEOUT_MS=${ms} */`
  // MySQL reads one hint comment per query block, so join one already there.
  const existingHint = /^\s*\/\*\+/.exec(rest)
  if (existingHint) {
    const hintStart = at + existingHint[0].length
    const hintClose = sqlText.indexOf("*/", hintStart)
    if (hintClose === -1) return sqlText
    return `${sqlText.slice(0, hintStart)} MAX_EXECUTION_TIME(${ms})${sqlText.slice(hintStart, hintClose + 2)}${directive}${sqlText.slice(hintClose + 2)}`
  }
  return `${sqlText.slice(0, at)} /*+ MAX_EXECUTION_TIME(${ms}) */${directive}${rest}`
}

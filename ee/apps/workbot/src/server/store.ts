import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"

/**
 * Who is signed in to Workbot, on this service's own disk. A browser holds only a random session id (in an
 * HttpOnly cookie); this keeps its hash, the person's Den tokens encrypted with WORKBOT_SESSION_SECRET, and the
 * short-lived state of a sign-in in progress. Nothing here is a copy of Den's data: Den is asked who the person
 * is on every request (cached briefly).
 */

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }
export type Session = { id: string; userId: string; organizationId: string; tokens: Tokens; createdAt: number }

const tokensSchema = z.object({ accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number() })
const sessionRow = z.object({ id: z.string(), user_id: z.string(), organization_id: z.string(), tokens: z.string(), created_at: z.number() })
const loginRow = z.object({ verifier: z.string(), return_to: z.string(), created_at: z.number() })

/** A sign-in must finish within this long. */
const LOGIN_TTL_MS = 10 * 60_000
/** Den's refresh tokens last 30 days; a session nobody used for that long is gone. */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60_000

export const hashSessionId = (raw: string) => createHash("sha256").update(raw).digest("hex")
export const randomToken = () => randomBytes(32).toString("base64url")

export class Store {
  private readonly db: DatabaseSync
  private readonly key: Buffer

  constructor(path: string, secret: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        tokens TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logins (
        state TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        return_to TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    this.key = createHash("sha256").update(`workbot-session:${secret}`).digest()
  }

  private seal(tokens: Tokens) {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".")
  }

  private open(sealed: string): Tokens | null {
    try {
      const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"))
      if (!iv || !tag || !body) return null
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv)
      decipher.setAuthTag(tag)
      const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
      const parsed = tokensSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      // A different secret (rotated) or a damaged row: the person signs in again.
      return null
    }
  }

  startLogin(state: string, verifier: string, returnTo: string) {
    const now = Date.now()
    this.db.prepare("DELETE FROM logins WHERE created_at < ?").run(now - LOGIN_TTL_MS)
    this.db.prepare("INSERT INTO logins (state, verifier, return_to, created_at) VALUES (?, ?, ?, ?)").run(state, verifier, returnTo, now)
  }

  /** The sign-in this state started, once: it is removed as it is read. */
  takeLogin(state: string): { verifier: string; returnTo: string } | null {
    const row = this.db.prepare("SELECT verifier, return_to, created_at FROM logins WHERE state = ?").get(state)
    this.db.prepare("DELETE FROM logins WHERE state = ?").run(state)
    const parsed = loginRow.safeParse(row)
    if (!parsed.success || parsed.data.created_at < Date.now() - LOGIN_TTL_MS) return null
    return { verifier: parsed.data.verifier, returnTo: parsed.data.return_to }
  }

  createSession(input: { userId: string; organizationId: string; tokens: Tokens }) {
    const raw = randomToken()
    const now = Date.now()
    this.db
      .prepare("INSERT INTO sessions (id, user_id, organization_id, tokens, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hashSessionId(raw), input.userId, input.organizationId, this.seal(input.tokens), now, now)
    return raw
  }

  getSession(raw: string): Session | null {
    const id = hashSessionId(raw)
    const parsed = sessionRow.safeParse(this.db.prepare("SELECT id, user_id, organization_id, tokens, created_at FROM sessions WHERE id = ?").get(id))
    if (!parsed.success) return null
    const tokens = this.open(parsed.data.tokens)
    if (!tokens) {
      this.deleteSession(id)
      return null
    }
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), id)
    return { id, userId: parsed.data.user_id, organizationId: parsed.data.organization_id, tokens, createdAt: parsed.data.created_at }
  }

  updateTokens(id: string, tokens: Tokens) {
    this.db.prepare("UPDATE sessions SET tokens = ? WHERE id = ?").run(this.seal(tokens), id)
  }

  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  }

  /** Forgets sessions nobody has used for a month (their Den refresh token has expired anyway). */
  sweep() {
    this.db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(Date.now() - SESSION_IDLE_MS)
    this.db.prepare("DELETE FROM logins WHERE created_at < ?").run(Date.now() - LOGIN_TTL_MS)
  }
}

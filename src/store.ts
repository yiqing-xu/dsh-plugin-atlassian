import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * What survives a restart: everything the OAuth flow cannot recompute cheaply.
 *
 * The access token is short-lived, but the refresh token, the dynamically
 * registered client, and the PKCE verifier are not — losing them means the
 * user authorizes again. The resolved redirect URI is stored too, because it
 * is baked into the registration.
 */
export interface StoredSession {
  version: 1
  /** The exact redirect URI the stored client registration was created with. */
  redirectUri?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** PKCE verifier for the authorization currently in flight. */
  codeVerifier?: string
  /** Site the user actually authorized, once known. */
  site?: string
  /**
   * The user switched the bridge off, keeping the authorization.
   *
   * Persisted so a restart does not quietly re-register the tools they just
   * suspended. Cleared by the next successful connect, never by a token
   * refresh — this is a UI decision, not a credential state.
   */
  suspended?: boolean
}

/**
 * One session file per `(serverName, url)` pair, under the harness home.
 *
 * The URL is hashed rather than interpolated: it is deployment input and must
 * never reach the filesystem as a path segment.
 */
export function sessionFileFor(serverName: string, url: string): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(home, '.dsh-atlassian', `${serverName}-${digest}.json`)
}

/**
 * A small JSON document with serialized read-modify-write.
 *
 * The OAuth client writes from several places (token refresh, code exchange,
 * the verifier save) and those writes can interleave with each other and with
 * a load. Every mutation goes through one promise chain so a later write never
 * resurrects a field an earlier one cleared.
 */
export class SessionStore {
  readonly #file: string
  #value: StoredSession = { version: 1 }
  #tail: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.#file = file
  }

  /** The file backing this store, for diagnostics. */
  get file(): string {
    return this.#file
  }

  /** The most recently loaded or written value. */
  get current(): StoredSession {
    return this.#value
  }

  /** Load from disk once. A missing or unreadable file is an empty session. */
  async load(): Promise<StoredSession> {
    return this.#serialize(async () => {
      try {
        const raw = await readFile(this.#file, 'utf8')
        // Tolerate a UTF-8 BOM: a file rewritten by an external editor or a
        // PowerShell pipeline would otherwise fail to parse, and the silent
        // fallback below would discard a perfectly good client registration.
        const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
        if (typeof parsed === 'object' && parsed !== null) {
          this.#value = { version: 1, ...(parsed as Omit<StoredSession, 'version'>) }
        }
      } catch {
        this.#value = { version: 1 }
      }
      return this.#value
    })
  }

  /** Merge a patch into the session and persist it. */
  async patch(patch: Partial<StoredSession>): Promise<void> {
    await this.#serialize(async () => {
      this.#value = { ...this.#value, ...patch }
      await this.#flush()
    })
  }

  /**
   * Drop the named fields and persist.
   *
   * Clearing is a write, not a delete: an empty document must be durable, so a
   * crash between an invalidated token and the next write cannot resurrect it.
   */
  async clear(...fields: readonly (keyof StoredSession)[]): Promise<void> {
    await this.#serialize(async () => {
      const next: StoredSession = { ...this.#value, version: 1 }
      for (const field of fields) delete next[field]
      this.#value = next
      await this.#flush()
    })
  }

  /** Remove the file entirely (used by the Settings "disconnect" action). */
  async destroy(): Promise<void> {
    await this.#serialize(async () => {
      this.#value = { version: 1 }
      try {
        await rm(this.#file, { force: true })
      } catch {
        // A file that cannot be removed is reported by the next write, not here.
      }
    })
  }

  async #flush(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    await writeFile(this.#file, `${JSON.stringify(this.#value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    // `mode` on writeFile only applies at creation; enforce it for existing files.
    try {
      await chmod(this.#file, 0o600)
    } catch {
      // Windows and exotic filesystems may not support POSIX modes.
    }
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    // Keep the chain alive after a rejection without surfacing it here.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

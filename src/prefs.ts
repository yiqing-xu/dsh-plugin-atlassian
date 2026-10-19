import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * What the Settings page persists for its own surfaces.
 *
 * Deliberately separate from {@link import('./store.js').SessionStore}: that
 * file is authorization material and `disconnect` deletes it. A UI preference
 * must survive both a disconnect and a new authorization, so it lives in its
 * own document.
 */
export interface Preferences {
  /**
   * Whether the Jira board is offered in the sidebar.
   *
   * `false` also withdraws the board's `main` panel registration, so a hidden
   * panel cannot be selected or left on screen.
   */
  panelVisible: boolean
  /**
   * Project keys pinned to the FRONT of the board's project row, in the order
   * they were pinned.
   *
   * Host-side rather than in the board's in-memory snapshot: a pin is a
   * deliberate "I read these projects" choice, and having to re-pin the same
   * projects after every reload is the one thing that would make it useless.
   * The array's order IS the pin order — that is the whole contract, so a
   * pinned project joins the end of this list, not the front.
   */
  pinnedProjects: string[]
  /**
   * Project keys the user actually OPENED on the board, newest first.
   *
   * This is the board's "recent" list, the counterpart of Jira's own sidebar:
   * a site routinely holds well over a hundred projects, and the row is useless
   * if it has to show all of them. Recency is the host's own record of what the
   * user selected — not a guess derived from the site's update timestamps, which
   * say when a project's issues moved, not whether this person looked at it.
   *
   * Bounded, because it is only ever a short "recently used" strip.
   */
  recentProjects: string[]
}

/**
 * The longest project key accepted into the document.
 *
 * Jira keys are short; the ceiling exists so a hand-edited file cannot make
 * every board render paint an unbounded row of chips.
 */
const MAX_PINNED_PROJECTS = 50

/**
 * How many recently-opened projects are remembered.
 *
 * Small on purpose: the strip is "what I was just doing", so a long list would
 * be the same unusable wall the full project list already is.
 */
const MAX_RECENT_PROJECTS = 8

/** A project key as Jira writes it, or undefined when the value cannot be one. */
function projectKeyOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  if (key === '' || key.length > 64) return undefined
  // Keys are `[A-Za-z][A-Za-z0-9_]*` in practice; rejecting whitespace keeps a
  // stray space from becoming a second, invisible pin.
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(key) ? key.toUpperCase() : undefined
}

/**
 * Read a pinned list from an untrusted document.
 *
 * Duplicates collapse on first occurrence, because the array's order IS the pin
 * order and a duplicate would silently shift every later project.
 */
function pinnedProjectsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const key = projectKeyOf(entry)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_PINNED_PROJECTS) break
  }
  return out
}

/** Read a recent list from an untrusted document, newest first. */
function recentProjectsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const key = projectKeyOf(entry)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_RECENT_PROJECTS) break
  }
  return out
}

/** What a profile gets before anything has been written. */
export const DEFAULT_PREFERENCES: Preferences = {
  panelVisible: true,
  pinnedProjects: [],
  recentProjects: [],
}

/**
 * One preference file per plugin row, under the harness home.
 *
 * Keyed by `serverName` rather than the endpoint URL: the preference is about
 * this installation's UI, and it should survive switching between Atlassian
 * endpoints or authorizing again.
 */
export function preferencesFileFor(serverName: string): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, '.dsh-atlassian', `${serverName}-prefs.json`)
}

/**
 * The UI preferences document.
 *
 * Small and local, but still written through one promise chain: the Settings
 * switch and a second Settings tab (or a reload racing a write) must never
 * interleave a read-modify-write and resurrect a stale value.
 *
 * Reads are permissive on purpose. A preference is a hint about presentation,
 * so a missing, truncated, or hand-edited file must leave the plugin usable —
 * every field falls back to its default instead of failing the page.
 */
export class PreferenceStore {
  readonly #file: string
  #value: Preferences = { ...DEFAULT_PREFERENCES }
  #loaded: Promise<void> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.#file = file
  }

  /** The file backing this store, for diagnostics. */
  get file(): string {
    return this.#file
  }

  /** The most recently loaded or written value. */
  get current(): Preferences {
    return this.#value
  }

  /** Load from disk once; a missing or unreadable file is the default. */
  async load(): Promise<Preferences> {
    this.#loaded ??= this.#read()
    await this.#loaded
    return this.#value
  }

  /** Merge a patch into the document, persist it, and return the result. */
  async patch(patch: Partial<Preferences>): Promise<Preferences> {
    await this.load()
    return this.#serialize(async () => {
      // Normalize the pinned list on the way IN as well as on the way out: a
      // write arrives from the browser, and the document on disk must be the
      // normalized form rather than whatever the request happened to contain.
      const next: Preferences = { ...this.#value, ...patch }
      if (patch.pinnedProjects !== undefined) next.pinnedProjects = pinnedProjectsOf(patch.pinnedProjects)
      if (patch.recentProjects !== undefined) next.recentProjects = recentProjectsOf(patch.recentProjects)
      this.#value = next
      await this.#flush()
      return this.#value
    })
  }

  async #read(): Promise<void> {
    try {
      const raw = await readFile(this.#file, 'utf8')
      // Tolerate a UTF-8 BOM: a file rewritten by an external editor or a
      // PowerShell pipeline would otherwise fail to parse and silently reset.
      const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        this.#value = {
          panelVisible: record['panelVisible'] !== false,
          pinnedProjects: pinnedProjectsOf(record['pinnedProjects']),
          recentProjects: recentProjectsOf(record['recentProjects']),
        }
      }
    } catch {
      this.#value = { ...DEFAULT_PREFERENCES }
    }
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

/**
 * The Jira board: a read-mostly projection of the same MCP connection the
 * agent uses.
 *
 * It exists so the panel never needs a model turn to answer "what is on my
 * plate". Everything here is a thin, defensive read over the bridged tools:
 * MCP answers arrive as content blocks carrying JSON text, and a site's issue
 * data is arbitrary, so every field is narrowed rather than trusted.
 *
 * The one write is a status transition. It is deliberately explicit — the
 * panel shows the transitions the server currently offers and sends back one
 * exact id — because Jira workflows are per-project state machines that no
 * client can guess.
 *
 * @module
 */

import type { AtlassianBridge } from './bridge.js'

/**
 * Pattern fragments for the v2 tools this module needs.
 *
 * v2 renamed the two board-only reads: `getVisibleJiraProjects` became
 * `listJiraProjects`, and `getTransitionsForJiraIssue` became
 * `listJiraIssueTransitions`. The search/issue/transition tools kept their
 * names.
 */
const TOOL = {
  resources: /accessibleatlassianresources/i,
  search: /searchJiraIssuesUsingJql/i,
  issue: /^getJiraIssue$/i,
  transitions: /^listJiraIssueTransitions$/i,
  transition: /^transitionJiraIssue$/i,
  projects: /^listJiraProjects$/i,
  fieldMeta: /^getJiraIssueTypeMetaWithFields$/i,
  boards: /^listJiraBoards$/i,
  sprints: /^listJiraBoardSprints$/i,
} as const

/** Compile every pattern once, so a fragment matches case-insensitively. */
const MATCHERS: Record<keyof typeof TOOL, RegExp> = {
  resources: new RegExp(TOOL.resources.source, 'i'),
  search: new RegExp(TOOL.search.source, 'i'),
  issue: new RegExp(TOOL.issue.source, 'i'),
  transitions: new RegExp(TOOL.transitions.source, 'i'),
  transition: new RegExp(TOOL.transition.source, 'i'),
  projects: new RegExp(TOOL.projects.source, 'i'),
  fieldMeta: new RegExp(TOOL.fieldMeta.source, 'i'),
  boards: new RegExp(TOOL.boards.source, 'i'),
  sprints: new RegExp(TOOL.sprints.source, 'i'),
}

/**
 * The custom-field id v2 resolves a sprint from when none is configured.
 *
 * Asking for `sprint` BY NAME does not work against the real server: custom
 * fields are silently dropped from the answer unless the request names their
 * `customfield_*` id. `customfield_10020` is Jira's conventional sprint field,
 * so it is the fallback whenever the deployment did not pin one.
 */
const DEFAULT_SPRINT_FIELD = 'customfield_10020'

/**
 * The tool surface this module needs.
 *
 * Structural rather than the concrete bridge so the data layer stays testable
 * and so a missing tool is a diagnosable error at call time instead of a
 * crash at wiring time.
 */
export interface ToolBridge {
  rawNameMatching(pattern: RegExp): string | undefined
  callTool(rawName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]>
  /** Coarse connection state, used to tell "not connected" from "no such tool". */
  snapshot?(): { status: string; error?: string | undefined }
}

/** One status as the panel renders it. */
export interface BoardStatus {
  /** Status name, e.g. `开发中`. Doubles as the identity of a column. */
  name: string
  /** Jira's coarse bucket: `new` | `indeterminate` | `done` | `undefined`. */
  categoryKey: string
  /** Human label of the bucket, for grouping headers. */
  categoryName: string
  /** Jira's own colour hint for the bucket. */
  colorName: string
}

/**
 * One sprint an issue belongs to.
 *
 * Jira keeps an ARRAY of these per issue: the newest sprint is last, and a
 * scrum board keeps the closed ones the issue was carried through. `state` is
 * what lets the panel order them (`active` → `future` → `closed`); it arrives
 * lower-cased by Jira but is not trusted to, so it is normalized on read.
 */
export interface BoardSprint {
  /** Jira's sprint id, or the name when the server only sent a name. */
  id: string
  name: string
  /** `active` | `future` | `closed`, lower-cased, or '' when omitted. */
  state: string
  startDate: string | undefined
  endDate: string | undefined
}

/**
 * One sprint OFFERED by the site, as a filter option.
 *
 * This is the enumerable side of the feature: a project's sprints are a known
 * list (RD003 alone offered 160), and the panel has to show all of them —
 * including the closed ones that no issue on the current page happens to carry,
 * which is exactly the case a "sprints seen on this page" derivation misses.
 * `boardId` is kept because the same sprint id is unique per site, but knowing
 * which board it came from is what lets a later refresh ask the right board.
 */
export interface BoardSprintOption {
  id: string
  name: string
  state: string
  startDate: string | undefined
  endDate: string | undefined
  boardId: string | undefined
  /** The board this option was listed from, so the panel can label the source. */
  boardName: string | undefined
}

/** One issue, flattened to exactly what a card or a drawer shows. */
export interface BoardIssue {
  key: string
  id: string
  summary: string
  status: BoardStatus
  /** Issue type name, e.g. `故事`, `缺陷`. */
  type: string
  priority: string | undefined
  /**
   * Assignee display name, when the issue has one.
   *
   * Frequently unset: a site whose issues are unassigned for the whole backlog
   * reports `null` here, and the panel must treat that as an ordinary state
   * rather than an empty filter.
   */
  assignee: string | undefined
  /** Reporter display name. Usually present even when nobody is assigned. */
  reporter: string | undefined
  updated: string | undefined
  projectKey: string | undefined
  projectName: string | undefined
  /**
   * Sprints this issue belongs to, newest state first.
   *
   * Empty for an issue outside every sprint, which is the ordinary case on a
   * kanban board — the panel must render that as "no sprint", not as an error.
   */
  sprints: BoardSprint[]
  /** Open-in-Jira target, built from the authorized site. */
  url: string | undefined
}

/** One status transition the server currently offers on an issue. */
export interface BoardTransition {
  id: string
  name: string
  toName: string
  toCategoryKey: string
}

/**
 * A project the authorization can see.
 *
 * `updated` is the site's own "last issue update" for the project, which is what
 * makes a "recent projects" list possible at all: a site routinely holds well
 * over a hundred projects, and the ones anybody reads are the ones that moved
 * recently. It is undefined when the site did not report an insight, which the
 * panel must treat as "no evidence of recency" rather than as "oldest".
 */
export interface BoardProject {
  key: string
  name: string
  /** ISO timestamp of the project's last issue update, when the site reports one. */
  updated: string | undefined
}

/** One issue plus its long-form body. */
export interface BoardIssueDetail {
  issue: BoardIssue
  /** Description as the MCP server rendered it (Markdown). */
  description: string
}

/** Everything one board render needs. */
export interface BoardPayload {
  /** Issues matching the effective query, newest update first. */
  issues: readonly BoardIssue[]
  /** True when the built-in bounded fallback produced the result, not the caller's JQL. */
  constrained: boolean
  /** The exact JQL that produced `issues`. */
  jql: string
  /** Authorized site host, when known. */
  site: string | undefined
  /** Registry it resolved the site from, when it had to. */
  cloudId: string | undefined
  truncated: boolean
  limit: number
}

/** Why a board read failed, in a form the panel can render. */
export class BoardError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BoardError'
    this.code = code
  }
}

/** Narrow an unknown to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * A non-empty id, as a string.
 *
 * Jira is inconsistent about numeric fields: a sprint carries `id: 5740` (a
 * NUMBER) while an issue key is always a string, and a custom-field projection
 * may hand the same value back as text. Everything downstream compares ids with
 * `===`, so they are normalized to one type here rather than at every call site.
 */
function idText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return text(value)
}

/** Concatenate the text blocks of an MCP content array. */
function contentText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    const item = record(block)
    const value = item === undefined ? undefined : text(item['text'])
    if (value !== undefined) parts.push(value)
  }
  return parts.join('\n')
}

/**
 * Unwrap the v2 tool envelope.
 *
 * Every Atlassian v2 tool answers with `{ "data": ... }`, while v1 answered
 * with the payload itself. The board reads the inner document, so an object
 * carrying `data` is treated as the envelope and anything else — including a
 * v1 payload that happens to be an array — is returned untouched.
 */
function unwrapEnvelope(value: unknown): unknown {
  const item = record(value)
  if (item === undefined) return value
  const data = item['data']
  return data === undefined ? value : data
}

/**
 * Parse a tool answer that should be JSON.
 *
 * The MCP server answers these tools with a JSON document inside a text block.
 * Some deployments wrap it in a fenced code block, so a leading fence is
 * stripped before parsing; anything else is reported as a shape error rather
 * than silently yielding an empty board.
 */
function parseJson(content: readonly unknown[], what: string): unknown {
  const raw = contentText(content).trim()
  if (raw === '') throw new BoardError('empty', `${what}：服务端返回了空内容`)
  const unfenced = raw.startsWith('```')
    ? raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')
    : raw
  try {
    return unwrapEnvelope(JSON.parse(unfenced))
  } catch {
    throw new BoardError('unparsable', `${what}：无法解析服务端返回（前 200 字符）${raw.slice(0, 200)}`)
  }
}

/**
 * The resource list inside an `*AccessibleAtlassianResources` answer.
 *
 * v2 answers `{ data: { resources: [...] } }`; v1 answered a bare array. Both
 * reduce to the same list, and an unrecognized shape is an empty list so the
 * caller can report "no site" rather than crash.
 */
function resourcesOf(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  const resources = at(value, 'resources')
  return Array.isArray(resources) ? resources : []
}

/** Decode the handful of entities Jira's HTML descriptions actually use. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Flatten a v2 HTML description into readable Markdown-ish text.
 *
 * v2 answers with HTML whenever the body holds media, mentions or panels, even
 * when Markdown was requested. The drawer renders Markdown and never injects
 * HTML, so tags are turned into their textual equivalents and the rest is
 * dropped rather than shown as literal markup.
 */
function htmlToText(html: string): string {
  let out = html
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(/<li[^>]*>/gi, '- ')
  out = out.replace(/<h([1-6])[^>]*>/gi, (_match: string, level: string) => `${'#'.repeat(Number(level))} `)
  out = out.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match: string, href: string, label: string) => `[${label.replace(/<[^>]+>/g, '')}](${href})`,
  )
  out = out.replace(
    /<div\b[^>]*\bdata-alt="([^"]*)"[^>]*>\s*<\/div>/gi,
    (_match: string, alt: string) => `[图片：${alt}]`,
  )
  out = out.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_match: string, alt: string) => `[图片：${alt}]`)
  out = out.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
  out = out.replace(/<[^>]+>/g, '')
  out = decodeEntities(out)
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read a nested string field by path. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const step of path) {
    const item = record(current)
    if (item === undefined) return undefined
    current = item[step]
  }
  return current
}

/** Read a nested non-empty string by path. */
function textAt(value: unknown, ...path: readonly string[]): string | undefined {
  return text(at(value, ...path))
}

/**
 * Derive a status-category bucket from its display name.
 *
 * v2's `evidence` projection returns only `statusCategory.name` (localized),
 * while `full` also carries `key`. The key is what the board groups and
 * filters by, so a name-only category is mapped back onto Jira's three
 * buckets instead of collapsing every issue into "undefined".
 */
function categoryKeyOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  if (/完成|done/i.test(name)) return 'done'
  if (/进行|处理中|indeterminate|in progress/i.test(name)) return 'indeterminate'
  if (/待办|未开始|new|todo|to do/i.test(name)) return 'new'
  return undefined
}

/**
 * Map a status object, defaulting the bucket when the server omits it.
 *
 * Every issue carries an embedded status, so the panel can group by status
 * name without a second request per issue.
 */
function statusOf(value: unknown): BoardStatus {
  const category = at(value, 'statusCategory')
  const categoryName = textAt(category, 'name')
  return {
    name: textAt(value, 'name') ?? '未知状态',
    categoryKey: textAt(category, 'key') ?? categoryKeyOf(categoryName) ?? 'undefined',
    categoryName: categoryName ?? '未分类',
    colorName: textAt(category, 'colorName') ?? 'blue-gray',
  }
}

/**
 * Normalize one sprint value.
 *
 * The server is not consistent about which field names a sprint: `id` is the
 * numeric id on some projections and missing on others, and `state` arrives as
 * `active`/`ACTIVE`/`Active` depending on the endpoint. Everything downstream
 * keys on `id` first so a rename does not collapse two sprints into one.
 */
function sprintOf(value: unknown): BoardSprint | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  // A sprint may be projected as a bare name string on legacy boards.
  const name = text(item['name'])
  // `id` is a NUMBER on the real payload; treating it as text-only silently
  // collapses every sprint onto its name, which then makes two same-named
  // sprints on different boards compare equal.
  const id = idText(item['id'])
  if (name === undefined && id === undefined) return undefined
  return {
    id: id ?? name ?? '',
    name: name ?? id ?? '',
    state: (text(item['state']) ?? '').toLowerCase(),
    startDate: text(item['startDate']),
    endDate: text(item['endDate']),
  }
}

/**
 * The sprints an issue carries, newest state first.
 *
 * Jira returns the array oldest-first (the currently active sprint last), which
 * is the opposite of what a chip list wants; a stable ordering by state also
 * keeps the chips from reshuffling between polls when an issue is moved.
 */
function sprintsOf(value: unknown): BoardSprint[] {
  if (!Array.isArray(value)) {
    // A scalar means the projection collapsed the array: treat it as one entry.
    const single = sprintOf(value)
    return single === undefined ? [] : [single]
  }
  const out: BoardSprint[] = []
  for (const entry of value) {
    const sprint = sprintOf(entry)
    if (sprint !== undefined) out.push(sprint)
  }
  const rank = (state: string): number => (state === 'active' ? 0 : state === 'future' ? 1 : 2)
  return out.sort((left, right) => rank(left.state) - rank(right.state))
}

/**
 * Whether a custom-field value has the shape of a sprint list.
 *
 * A sprint is the only custom field Jira projects as objects carrying BOTH a
 * `state` and a `name`, so this is a reliable last resort when neither the
 * well-known key nor the configured id finds it. It is a shape test rather than
 * a name test on purpose: the keys under `fields.customFields` are the user's
 * LOCALIZED field names (`冲刺`, `Sprint`, `スプリント`), and matching those
 * would break on every site whose UI language differs from the one assumed.
 */
function looksLikeSprintList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  const first = record(value[0])
  return first !== undefined && typeof first['name'] === 'string' && first['state'] !== undefined
}

/**
 * Find the sprint list on one issue.
 *
 * The v2 server answers custom fields under `fields.customFields`, keyed by the
 * field's DISPLAY name and wrapped as `{ id, value }` — e.g.
 * `customFields["冲刺"] = { id: "customfield_10020", value: [ ... ] }`. That is
 * why `fields.sprint` alone finds nothing on a real site. The lookups run from
 * most to least specific:
 *
 * 1. `fields.sprint`, for a v1 payload or a search projection that flattens it;
 * 2. `fields[<configured id>]`, a bare custom-field key on some projections;
 * 3. a `customFields` entry whose `id` equals the configured id;
 * 4. a `customFields` entry whose VALUE has the sprint shape.
 */
function sprintFieldOf(fields: unknown, sprintField: string): BoardSprint[] {
  const direct = at(fields, 'sprint')
  if (direct !== undefined) {
    const sprints = sprintsOf(direct)
    if (sprints.length > 0) return sprints
  }

  const configured = sprintField.trim()
  if (configured !== '') {
    const bare = at(fields, configured)
    if (bare !== undefined) {
      const sprints = sprintsOf(bare)
      if (sprints.length > 0) return sprints
    }
  }

  const custom = record(at(fields, 'customFields'))
  if (custom === undefined) return []

  const entries = Object.values(custom)
  if (configured !== '') {
    for (const entry of entries) {
      const item = record(entry)
      if (item === undefined || idText(item['id']) !== configured) continue
      const sprints = sprintsOf(item['value'])
      // Deliberately an empty list here: the configured id is authoritative, so
      // a matching field that holds no sprints means the issue is in none.
      return sprints
    }
  }
  for (const entry of entries) {
    const item = record(entry)
    if (item === undefined) continue
    if (!looksLikeSprintList(item['value'])) continue
    return sprintsOf(item['value'])
  }
  return []
}

/** Flatten one issue payload. Returns undefined when it carries no key. */
function issueOf(
  value: unknown,
  site: string | undefined,
  sprintField: string,
): BoardIssue | undefined {
  const key = textAt(value, 'key')
  if (key === undefined) return undefined
  const fields = at(value, 'fields')
  const projectKey = textAt(fields, 'project', 'key')
  return {
    key,
    id: textAt(value, 'id') ?? key,
    summary: textAt(fields, 'summary') ?? '(无标题)',
    status: statusOf(at(fields, 'status')),
    type: textAt(fields, 'issuetype', 'name') ?? '',
    priority: textAt(fields, 'priority', 'name'),
    assignee: textAt(fields, 'assignee', 'displayName'),
    reporter: textAt(fields, 'reporter', 'displayName'),
    updated: textAt(fields, 'updated'),
    projectKey,
    projectName: textAt(fields, 'project', 'name'),
    sprints: sprintFieldOf(fields, sprintField),
    url:
      site === undefined
        ? undefined
        : `https://${site}/browse/${encodeURIComponent(key)}`,
  }
}

/**
 * Turn a JQL restriction failure into a hint the user can act on.
 *
 * Atlassian refuses wholly unconstrained queries, and the message is the only
 * signal that the query itself — not the connection — is the problem.
 */
function looksUnconstrained(message: string): boolean {
  return /unbounded|unrestricted|不允许使用无限制|add a search restriction|至少/i.test(message)
}

/**
 * How many issues one search request may return.
 *
 * The server accepts up to 100; asking for less only costs round-trips, so the
 * board always asks for a full page and pages from there.
 */
const SEARCH_PAGE_SIZE = 100

/**
 * How many projects one `listJiraProjects` page may return.
 *
 * The tool defaults to a small page, which is exactly how a project the user
 * works in every day could be missing from the filter row. The board asks for
 * the maximum and pages until the site says it is done.
 */
const PROJECT_PAGE_SIZE = 100

/** A board query: the JQL plus the safety ceiling on one read. */
export interface BoardQuery {
  /** Caller-supplied JQL, or the deployment default when omitted. */
  jql?: string | undefined
  /**
   * The most issues one read may collect.
   *
   * This is a SAFETY CEILING, not a page size: the read pages through the query
   * until the server reports the result complete, and only stops here. It
   * exists so a site with tens of thousands of matching issues cannot hang the
   * panel, which is why it is deliberately far above what a project holds.
   */
  limit: number
  timeoutMs: number
  /**
   * The custom-field id backing the sprint field, when it is not the default
   * `sprint`. Sites that renamed it (or that expose several) set this in config;
   * the board then requests and reads that field in addition to `sprint`.
   */
  sprintField?: string | undefined
}

/**
 * One board over one bridge.
 *
 * The authorized site and its registry id are resolved once and cached, since
 * every Jira tool on this server requires the id explicitly and re-resolving it
 * per request would double the round-trips of every refresh.
 */
export class JiraBoard {
  readonly #bridge: ToolBridge
  #cloudId: string | undefined
  #resolving: Promise<string> | undefined
  /** The resolved sprint custom-field id, once known. */
  #sprintField: string | undefined
  #resolvingSprint: Promise<string> | undefined

  constructor(bridge: ToolBridge) {
    this.#bridge = bridge
  }

  /** Whether the panel can be served at all right now. */
  available(): boolean {
    return this.#bridge.rawNameMatching(MATCHERS.search) !== undefined
  }

  /** The cached authorized site host, once known. */
  get site(): string | undefined {
    return this.#site
  }

  #site: string | undefined

  /**
   * Call one tool by fragment, failing with the fragment when it is absent.
   *
   * @param pattern - Fragment identifying the tool.
   * @param args - Tool arguments.
   * @param timeoutMs - Optional deadline override.
   * @returns The MCP content blocks.
   */
  async #call(pattern: RegExp, args: Record<string, unknown>, timeoutMs?: number): Promise<readonly unknown[]> {
    const rawName = this.#bridge.rawNameMatching(pattern)
    if (rawName === undefined) {
      // An unconnected bridge has discovered no tools at all, and calling that
      // "the server did not provide this tool" sends the user hunting for a
      // permission problem instead of connecting.
      const health = this.#bridge.snapshot?.()
      if (health !== undefined && health.status !== 'ready') {
        throw new BoardError(
          'not-connected',
          health.error ?? `Atlassian 连接尚未就绪（状态：${health.status}）— 到 设置 → Atlassian 完成连接`,
        )
      }
      throw new BoardError(
        'missing-tool',
        `服务端没有提供匹配 ${String(pattern)} 的工具 — 可能未授权 Jira 产品`,
      )
    }
    try {
      return await this.#bridge.callTool(rawName, args, timeoutMs)
    } catch (error) {
      throw new BoardError('tool-failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The registry id (UUID or host) every Jira tool requires.
   *
   * The first authorized resource is the site the token is scoped to — this
   * authorization covers exactly one, so "first" is not a guess.
   */
  async cloudId(): Promise<string> {
    if (this.#cloudId !== undefined) return this.#cloudId
    if (this.#resolving === undefined) {
      this.#resolving = (async (): Promise<string> => {
        const content = await this.#call(MATCHERS.resources, {}, 20_000)
        const parsed = parseJson(content, '查询可访问站点')
        // v2 names it `cloudId` inside `data.resources`; v1 used `id`.
        for (const entry of resourcesOf(parsed)) {
          const id = textAt(entry, 'cloudId') ?? textAt(entry, 'id')
          if (id === undefined) continue
          const url = textAt(entry, 'url')
          if (url !== undefined) {
            try {
              this.#site = new URL(url).host
            } catch {
              this.#site = url
            }
          }
          this.#cloudId = id
          return id
        }
        throw new BoardError('no-site', '授权里没有任何可访问的 Jira 站点')
      })().finally(() => {
        this.#resolving = undefined
      })
    }
    return this.#resolving
  }

  /**
   * The custom-field id the sprint lives in.
   *
   * `sprint` requested by NAME is silently dropped by the real server — custom
   * fields only come back when their `customfield_*` id is named — so the id
   * has to be resolved rather than assumed. A configured id wins outright (the
   * deployment knows its site); otherwise the field catalogue is asked for the
   * field whose display name looks like a sprint, and only then does the
   * conventional `customfield_10020` serve as the fallback.
   *
   * Cached, and a failure is cached too: this is an optimisation for one
   * request per process, and a site that refuses the metadata tool must not
   * turn every refresh into two failing round-trips.
   */
  async sprintField(configured: string): Promise<string> {
    const pinned = configured.trim()
    if (pinned !== '') return pinned
    if (this.#sprintField !== undefined) return this.#sprintField
    if (this.#resolvingSprint === undefined) {
      this.#resolvingSprint = (async (): Promise<string> => {
        let resolved = DEFAULT_SPRINT_FIELD
        if (this.#bridge.rawNameMatching(MATCHERS.fieldMeta) !== undefined) {
          try {
            const cloudId = await this.cloudId()
            // `PICDLY`-style project keys are what the metadata tool wants; any
            // issue type will do, because the sprint field is site-wide. The
            // board asks for the project it is about to search when it knows it.
            const content = await this.#call(
              MATCHERS.fieldMeta,
              { cloudId, projectIdOrKey: this.#projectHint ?? '', requiredFieldsOnly: false, maxResults: 200 },
              20_000,
            )
            const parsed = parseJson(content, '查询字段定义')
            const list = at(parsed, 'fields')
            if (Array.isArray(list)) {
              for (const entry of list) {
                const id = textAt(entry, 'fieldId')
                const name = textAt(entry, 'name')
                if (id === undefined || name === undefined) continue
                // `冲刺` / `Sprint` / `スプリント` — matching the localized name
                // is unavoidable here, because the id itself carries no meaning.
                if (!/冲刺|sprint/i.test(name)) continue
                // An array of objects (`items: json`) is the real sprint field;
                // a `string` field that merely says "冲刺" in its name is a
                // different, unrelated custom field.
                const items = at(entry, 'schema', 'items')
                if (items !== 'json') continue
                resolved = id
                break
              }
            }
          } catch {
            // Fall through to the conventional id: a board with a wrong sprint
            // field is still a working board.
          }
        }
        this.#sprintField = resolved
        return resolved
      })().finally(() => {
        this.#resolvingSprint = undefined
      })
    }
    return this.#resolvingSprint
  }

  /**
   * The project the last query narrowed to, used as the metadata lookup hint.
   *
   * Deliberately a hint and never a constraint: the sprint field is the same on
   * every project of a site, so a wrong value only costs the fallback path.
   */
  #projectHint: string | undefined

  /**
   * Load the board.
   *
   * The read PAGES THROUGH the query until the server reports the result
   * complete, so the panel holds the whole project rather than an arbitrary
   * first screen. `query.limit` is a safety ceiling on that walk, not a page
   * size: it exists only so a pathological site cannot hang the panel, and a
   * normal project — a few hundred issues — never reaches it.
   *
   * Two query attempts at most: a JQL the deployment or the user supplied, and
   * — only when the server refused it as unconstrained — a bounded fallback.
   * Any other failure is reported as-is rather than retried, because a bad JQL
   * should be visible, not silently replaced.
   */
  async load(query: BoardQuery): Promise<BoardPayload> {
    const requested = query.jql?.trim() ?? ''
    const fallback = 'updated >= -180d ORDER BY updated DESC'
    let jql = requested === '' ? fallback : requested
    // Tracks whether the FALLBACK is already in force, which is what bounds the
    // retry to one. It is not "the user supplied something": a user JQL that the
    // server rejects as unconstrained is exactly the case the fallback is for.
    let usedFallback = requested === ''
    // A `project = KEY` clause in the query is the cheapest possible hint for
    // the field-metadata lookup, so it is taken from the query already at hand.
    const projectHint = /\bproject\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?/i.exec(jql)?.[1]
    if (projectHint !== undefined) this.#projectHint = projectHint
    // The sprint field is requested BY ID: naming it `sprint` makes the server
    // drop it silently, which is what made every sprint chip empty.
    const sprintField = await this.sprintField(query.sprintField ?? '')
    const fields = [
      'summary',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'reporter',
      'updated',
      'project',
      sprintField,
    ]
    const cloudId = await this.cloudId()

    const issues: BoardIssue[] = []
    // Pages can overlap when the underlying data shifts between requests, and a
    // duplicated card is a duplicated key in every list the panel builds.
    const seen = new Set<string>()
    let nextPageToken: string | undefined
    let truncated = false
    let exhausted = false

    while (!exhausted) {
      const remaining = Math.max(0, query.limit - issues.length)
      if (remaining === 0) {
        // Stopped by the ceiling with work still outstanding, which is exactly
        // what the panel must report instead of implying the board is complete.
        truncated = true
        break
      }

      let parsed: unknown
      try {
        const content = await this.#call(
          MATCHERS.search,
          {
            cloudId,
            jql,
            fields,
            maxResults: Math.min(SEARCH_PAGE_SIZE, remaining),
            // v2 pages by opaque token, not by offset: an offset would skip or
            // repeat issues whenever one is edited mid-walk.
            ...(nextPageToken === undefined ? {} : { nextPageToken }),
            // v2 defaults to the compact projection, which drops the status
            // category and the project — the two fields the board filters on.
            view: 'full',
          },
          query.timeoutMs,
        )
        parsed = parseJson(content, '搜索工单')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!usedFallback && looksUnconstrained(message)) {
          usedFallback = true
          jql = fallback
          nextPageToken = undefined
          continue
        }
        throw error
      }

      const source = at(parsed, 'issues') ?? (Array.isArray(parsed) ? parsed : undefined)
      const rawIssues = Array.isArray(source) ? source : []
      for (const raw of rawIssues) {
        const issue = issueOf(raw, this.#site, sprintField)
        if (issue === undefined || seen.has(issue.key)) continue
        seen.add(issue.key)
        issues.push(issue)
      }

      const more = at(parsed, 'isLast') === false
      const token = textAt(parsed, 'nextPageToken')
      if (!more) {
        exhausted = true
      } else if (token === undefined || token === nextPageToken) {
        // The server says there is more but gave no way to ask for it. Saying
        // "truncated" is honest; looping forever would not be.
        truncated = true
        exhausted = true
      } else if (rawIssues.length === 0) {
        // A page that contributed nothing while claiming a successor: stop
        // rather than spin on a token the site keeps repeating.
        truncated = true
        exhausted = true
      } else {
        nextPageToken = token
      }
    }

    return {
      issues,
      constrained: jql === fallback && requested !== fallback,
      jql,
      site: this.#site,
      cloudId,
      truncated,
      limit: query.limit,
    }
  }

  /** One issue with its description, for the drawer. */
  async detail(key: string, timeoutMs: number, sprintField?: string): Promise<BoardIssueDetail> {
    const cloudId = await this.cloudId()
    // Resolved through the same path the board uses, so the drawer shows the
    // sprints a card showed — a field id of '' would silently drop them here.
    const field = await this.sprintField(sprintField ?? '')
    const content = await this.#call(
      MATCHERS.issue,
      {
        cloudId,
        issueIdOrKey: key,
        responseContentFormat: 'markdown',
        view: 'full',
        fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated', 'project', 'description', field],
      },
      timeoutMs,
    )
    const parsed = parseJson(content, `读取 ${key}`)
    // `getJiraIssue` may answer with the issue directly or inside `issues`.
    const candidate = at(parsed, 'issues', '0') ?? parsed
    const issue = issueOf(candidate, this.#site, field)
    if (issue === undefined) throw new BoardError('not-found', `读不到 ${key} 的内容`)
    const description = textAt(candidate, 'fields', 'description') ?? ''
    return {
      issue,
      // v2 refuses Markdown when the body holds media or mentions. The panel
      // renders Markdown, so an HTML answer is flattened here instead of
      // leaking tags into the drawer.
      description:
        textAt(candidate, 'appliedContentFormat') === 'html' ? htmlToText(description) : description.trim(),
    }
  }

  /** The transitions the server currently offers on one issue. */
  async transitions(key: string, timeoutMs: number): Promise<readonly BoardTransition[]> {
    const cloudId = await this.cloudId()
    const content = await this.#call(
      MATCHERS.transitions,
      { cloudId, issueIdOrKey: key },
      timeoutMs,
    )
    const parsed = parseJson(content, `读取 ${key} 的可用流转`)
    const source = at(parsed, 'transitions') ?? (Array.isArray(parsed) ? parsed : undefined)
    const list = Array.isArray(source) ? source : []
    const out: BoardTransition[] = []
    for (const raw of list) {
      const id = textAt(raw, 'id')
      const name = textAt(raw, 'name')
      if (id === undefined || name === undefined) continue
      out.push({
        id,
        name,
        toName: textAt(raw, 'to', 'name') ?? name,
        toCategoryKey: textAt(raw, 'to', 'statusCategory', 'key') ?? 'undefined',
      })
    }
    return out
  }

  /**
   * Apply one transition.
   *
   * The id must have come from {@link transitions} for this same issue: the
   * panel never constructs one, because a transition id is only meaningful
   * inside the workflow state it was read from.
   */
  async transition(key: string, transitionId: string, timeoutMs: number): Promise<void> {
    const cloudId = await this.cloudId()
    await this.#call(
      MATCHERS.transition,
      { cloudId, issueIdOrKey: key, transitionId },
      timeoutMs,
    )
  }

  /**
   * Every project this authorization can see, in one list.
   *
   * Paged to exhaustion on purpose: the tool's default page is 50 and this site
   * holds 148 projects, so a single request is precisely how a project the user
   * works in every day goes missing. The tool pages by `startAt` OFFSET (its
   * `nextPage` is a URL, not a token), so the walk advances by the page size and
   * stops on `isLast`.
   *
   * `expand: insight` is requested because it carries `lastIssueUpdateTime` —
   * the only recency signal a project exposes. Without it the panel could only
   * sort alphabetically, and "recent projects" would be a guess.
   */
  async projects(timeoutMs: number): Promise<readonly BoardProject[]> {
    const cloudId = await this.cloudId()
    const out: BoardProject[] = []
    const seen = new Set<string>()

    for (let startAt = 0; ; ) {
      const parsed = parseJson(
        await this.#call(
          MATCHERS.projects,
          { cloudId, startAt, maxResults: PROJECT_PAGE_SIZE, expand: 'insight' },
          timeoutMs,
        ),
        '读取项目列表',
      )
      const source =
        at(parsed, 'values') ?? at(parsed, 'projects') ?? (Array.isArray(parsed) ? parsed : undefined)
      const list = Array.isArray(source) ? source : []
      for (const raw of list) {
        const key = textAt(raw, 'key')
        if (key === undefined || seen.has(key)) continue
        seen.add(key)
        out.push({
          key,
          name: textAt(raw, 'name') ?? key,
          updated: textAt(raw, 'insight', 'lastIssueUpdateTime'),
        })
      }

      const total = typeof at(parsed, 'total') === 'number' ? (at(parsed, 'total') as number) : undefined
      const more = at(parsed, 'isLast') === false
      // No progress is no progress: a site that keeps answering the same page
      // must end the walk instead of looping forever.
      if (!more || list.length === 0) break
      startAt += list.length
      if (total !== undefined && startAt >= total) break
    }

    return out.sort((a, b) => a.key.localeCompare(b.key))
  }

  /**
   * The sprints offered by a project's boards, as filter options.
   *
   * A sprint is not a boolean: "is it in a sprint" is a property of an issue,
   * but what a filter row offers is the site's sprint CATALOGUE — RD003 alone
   * runs 160 of them across its boards. So this walks the project's boards and
   * lists every sprint on each, closed ones included, because a chip the user
   * remembers from last quarter has to be selectable even after the page no
   * longer shows any of its issues.
   *
   * Boards are listed even when the project has several (a site often keeps one
   * per team plus a legacy board); the union is what is returned, de-duplicated
   * by sprint id, and each option remembers the board it came from.
   */
  async sprints(projectKey: string, timeoutMs: number): Promise<readonly BoardSprintOption[]> {
    const cloudId = await this.cloudId()
    const key = projectKey.trim()
    if (key === '') return []
    const boardsContent = await this.#call(
      MATCHERS.boards,
      { cloudId, projectKeyOrId: key, maxResults: 50 },
      timeoutMs,
    )
    const boards = parseJson(boardsContent, `读取 ${key} 的面板`)
    const boardList = at(boards, 'values') ?? (Array.isArray(boards) ? boards : undefined)
    const boardsFound = Array.isArray(boardList) ? boardList : []

    const out: BoardSprintOption[] = []
    const seen = new Set<string>()
    // A project's boards are few, so they are asked in parallel: a serial walk
    // would add one round-trip per board to a filter row's opening.
    interface BoardSprints {
      boardId: string
      boardName: string | undefined
      rows: readonly unknown[]
    }
    const results = await Promise.all(
      boardsFound.map(async (board): Promise<BoardSprints | undefined> => {
        const boardId = idText(at(board, 'id'))
        if (boardId === undefined) return undefined
        const rows: unknown[] = []
        try {
          // The tool caps a page at 50 regardless of `maxResults`, and a long
          // running board really does hold more (RD003's oldest board lists
          // 160). Page through it, bounded so a pathological board cannot hold
          // the filter row open forever.
          const MAX_PAGES = 8
          for (let page = 0; page < MAX_PAGES; page += 1) {
            const content = await this.#call(
              MATCHERS.sprints,
              { cloudId, boardId: Number(boardId), state: 'all', maxResults: 100, startAt: page * 50 },
              timeoutMs,
            )
            const parsed = parseJson(content, `读取面板 ${boardId} 的冲刺`)
            const source = at(parsed, 'values') ?? (Array.isArray(parsed) ? parsed : undefined)
            if (!Array.isArray(source) || source.length === 0) break
            rows.push(...source)
            // `isLast` is authoritative; a short page is the fallback signal for
            // a server that omits it.
            if (at(parsed, 'isLast') === true || source.length < 50) break
          }
        } catch {
          // A board the token can see but not read (a private team board) must
          // not fail the whole list: the other boards still answer, and whatever
          // this board already yielded is still usable.
        }
        return { boardId, boardName: textAt(board, 'name'), rows }
      }),
    )
    for (const result of results) {
      if (result === undefined) continue
      for (const raw of result.rows) {
        const id = idText(at(raw, 'id'))
        if (id === undefined || seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          name: textAt(raw, 'name') ?? id,
          state: (textAt(raw, 'state') ?? '').toLowerCase(),
          startDate: textAt(raw, 'startDate'),
          endDate: textAt(raw, 'endDate'),
          boardId: result.boardId,
          boardName: result.boardName,
        })
      }
    }
    return out
  }
}

/** Build a board over the live bridge. */
export function createBoard(bridge: AtlassianBridge): JiraBoard {
  return new JiraBoard(bridge)
}

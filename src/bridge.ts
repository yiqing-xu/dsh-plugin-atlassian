import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CallbackServer, AtlassianOAuthProvider, type Logger } from './oauth.js'
import { openInBrowser } from './open-url.js'
import type { SessionStore } from './store.js'

/** Identity reported to the MCP server. */
const CLIENT_NAME = 'dsh-plugin-atlassian'
const CLIENT_VERSION = '0.1.0'

/**
 * DeepSeek function-name contract: at most 64 characters.
 *
 * Copied from `@deepseek-ai/dsh-mcp-client` on purpose — the two bridges must
 * derive identical names for the same `(serverName, rawName)`, or a tool
 * bridged by one and re-bridged by the other would change identity and
 * invalidate session history and permission rules.
 */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * The model-facing name of one MCP tool.
 *
 * The clean case is `mcp__<serverName>__<rawName>` verbatim. When character
 * replacement or truncation is needed, a 12-hex-char SHA-256 of the identity is
 * appended so two distinct MCP tools can never collapse into one name.
 *
 * @param serverName - Deployment-owned namespace.
 * @param rawName - The MCP server's own tool name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Where the bridge registers the tools it discovers. */
export interface BridgeHost {
  register(definition: ToolDefinition): () => void
  logger: Logger
}

/** Deployment-owned settings the bridge reads. */
export interface BridgeOptions {
  serverName: string
  /** Endpoint whose tools are registered for the model. */
  url: string
  /**
   * Endpoint whose tools the Jira board calls by name.
   *
   * Equal to `url` means one connection serves both (the pre-`boardUrl`
   * behaviour). A different value opens a second MCP session over the SAME
   * authorization: both URLs point at `/v2/mcp`, so they are one OAuth resource
   * and one store file.
   */
  boardUrl: string
  /** Loopback port to prefer for the OAuth redirect; `0` picks a free one. */
  redirectPort: number
  toolCallTimeoutMs: number
  expectedSite: string
  authorizationTimeoutMs: number
  autoOpenBrowser: boolean
  store: SessionStore
}

/**
 * Coarse connection state, as the Settings page shows it.
 *
 * `disconnected` is deliberately distinct from `idle`: both mean "no live MCP
 * session and no registered tools", but only `idle` means "there is no
 * authorization at all". `disconnected` says the user switched the bridge off
 * while keeping the stored credentials, so the next connect is a silent
 * reconnect rather than another browser round-trip.
 */
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'disconnected' | 'error'

/** A point-in-time view for the Settings page and the log. */
export interface BridgeSnapshot {
  status: BridgeStatus
  /** Present while a browser visit is needed. */
  authorizationUrl: string | undefined
  /** Site the authorization actually granted, when it could be determined. */
  site: string | undefined
  /** `true` when `site` contradicts the configured `expectedSite`. */
  siteMismatch: boolean
  /**
   * `true` when a stored authorization exists.
   *
   * What tells the Settings page whether the next connect can be silent: with
   * credentials on disk, `connect` re-opens the MCP sessions and re-registers
   * the tools without a browser round-trip.
   */
  authorized: boolean
  /** Number of tools currently registered from this server. */
  toolCount: number
  error: string | undefined
}

/** One tool exactly as this connection registered it. */
export interface BridgedTool {
  /** Public DSH tool name, e.g. `mcp__atlassian__getJiraIssue`. */
  name: string
  /** Raw MCP name the server listed, e.g. `getJiraIssue`. */
  rawName: string
  /** Description the server supplied, verbatim. */
  description: string
  /**
   * `false` for a tool only the board's catalogue knows.
   *
   * With `boardUrl` pointing at the flat `?tools=all` catalogue and `url` at
   * the default endpoint, the Settings page lists both: the model only ever
   * sees (and pays context for) the registered subset.
   */
  registered: boolean
}

/** What an on-demand token probe concluded. */
export type ConnectionTestVerdict =
  | 'valid'
  | 'refreshed'
  | 'invalid'
  | 'degraded'
  | 'unknown'
  | 'not-connected'

/**
 * The result of probing the live connection's credentials.
 *
 * Deliberately a separate wire shape from {@link BridgeSnapshot}: a probe is a
 * point-in-time answer, not a new connection state. Only `invalid` changes the
 * snapshot (the credentials are dropped and the tools unregistered).
 */
export interface ConnectionTest {
  /** `true` only when the probe proved the connection usable right now. */
  ok: boolean
  verdict: ConnectionTestVerdict
  /** ISO timestamp of when the probe finished. */
  checkedAt: string
  durationMs: number
  /** MCP tool the probe called, or `tools/list` when no probe tool existed. */
  tool?: string
  /** Site the probe confirmed, when the tool returns resources. */
  site?: string
  message: string
}

/** One probe must not outlive a click by much; the normal call has 60s. */
const PROBE_TIMEOUT_MS = 20_000

/** Bound a server message before it reaches the page. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** The HTTP status a transport error carries, when it carries one. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as Record<string, unknown>
  for (const key of ['code', 'status', 'statusCode']) {
    const value = record[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

/**
 * Whether an error means the credentials themselves were rejected.
 *
 * The distinction matters: a network failure or a 5xx says nothing about the
 * token, so the probe must report "unknown" and leave the connection alone.
 * A 401, an OAuth `invalid_grant` (dead refresh token), or an `invalid_client`
 * (dead registration) all mean re-authorization is unavoidable.
 */
function isAuthFailure(signature: string, status: number | undefined): boolean {
  if (status === 401) return true
  return /invalid_?(?:grant|token|client)|unauthorized|token.*(?:expired|invalid)/i.test(signature)
}

/** Join MCP content blocks into the text the model reads. */
function extractText(content: unknown, rawName: string): string {
  if (!Array.isArray(content)) return `(${rawName} returned no content)`
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      parts.push(String(block))
      continue
    }
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
      continue
    }
    if (record['type'] === 'resource' && typeof record['resource'] === 'object' && record['resource'] !== null) {
      const resource = record['resource'] as Record<string, unknown>
      parts.push(`[resource ${String(resource['uri'] ?? '(no uri)')}]`)
      continue
    }
    parts.push(`[${String(record['type'] ?? 'unknown')} content is not rendered by this bridge]`)
  }
  return parts.length === 0 ? `(${rawName} returned no content)` : parts.join('\n\n')
}

/**
 * Read the site host out of an `*AccessibleAtlassianResources` payload.
 *
 * v2 wraps every tool answer in `{ data }` and lists sites under
 * `data.resources` (`cloudId`, not `id`); v1 answered a bare array. Only `url`
 * matters here, and it is common to both shapes.
 */
function siteFromResources(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as Record<string, unknown>)['text']
    if (typeof text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(text)
      let body = parsed
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const data = (body as Record<string, unknown>)['data']
        if (data !== undefined) body = data
      }
      const resources =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)['resources']
          : undefined
      const entries = Array.isArray(body) ? body : Array.isArray(resources) ? resources : []
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue
        const url = (entry as Record<string, unknown>)['url']
        if (typeof url === 'string' && url !== '') {
          try {
            return new URL(url).host
          } catch {
            return url
          }
        }
      }
    } catch {
      // A non-JSON answer simply yields no site.
    }
  }
  return undefined
}

/** A pending `#waitUntil` registration. */
interface Waiter {
  predicate: () => boolean
  settle: () => void
}

/**
 * Find the raw MCP name matching a fragment in one session.
 *
 * Case-insensitive because the Jira panel's callers name capabilities
 * (`searchJiraIssuesUsingJql`), and a server-side rename must not silently
 * break the panel. Kept module-level so the bridge and `#detectSite` share one
 * definition of "matching".
 */
function findRawName(session: McpSession | undefined, pattern: RegExp): string | undefined {
  if (session === undefined) return undefined
  for (const raw of session.raw.values()) {
    if (pattern.test(raw)) return raw
  }
  return undefined
}

/**
 * Read every entry of a paginated `tools/list`.
 *
 * Atlassian's v2 server paginates the flat `?tools=all` catalogue, so reading
 * only the first page would silently hide most tools. A repeated cursor is
 * refused rather than followed: a server looping on one cursor would otherwise
 * hang the connection forever.
 *
 * @param client - A connected MCP client.
 * @returns The listed tools, in server order.
 */
async function listAllTools(client: Client): Promise<ListedTool[]> {
  const tools: ListedTool[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await client.listTools(cursor === undefined ? {} : { cursor })
    for (const tool of response.tools) {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      })
    }
    cursor = response.nextCursor
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error('atlassian: server repeated a tools/list continuation cursor — refusing an invalid tool list')
      }
      seenCursors.add(cursor)
    }
  } while (cursor !== undefined)
  return tools
}

/**
 * One live MCP session plus the raw names it listed.
 *
 * The model session and the board session are structurally identical; they
 * differ only in which endpoint they speak to and whether their tools are
 * registered. Keeping them the same shape is what lets `boardUrl` empty out
 * into a single shared session without a second code path.
 */
interface McpSession {
  client: Client
  /** public tool name → the raw MCP name `tools/call` must carry. */
  raw: Map<string, string>
}

/** One entry of a paginated `tools/list`, narrowed to what this bridge reads. */
interface ListedTool {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * Owns the MCP connection, the OAuth interaction, and the tool generation.
 *
 * One instance per composition row. Tool registration is generation-based:
 * discovery builds a complete next generation, and only a fully successful
 * build swaps it in, so a failed re-sync leaves the previous tools usable.
 *
 * Two sessions may run at once. The model session speaks {@link BridgeOptions.url}
 * and its tools are registered; the board session speaks
 * {@link BridgeOptions.boardUrl} and is never registered, because the flat
 * `?tools=all` catalogue it needs would otherwise cost every request the
 * definitions of ~200 tools. Both URLs point at the same OAuth resource, so
 * they share one authorization and one store file.
 */
export class AtlassianBridge {
  readonly #host: BridgeHost
  readonly #options: BridgeOptions
  readonly #callback = new CallbackServer()
  readonly #provider: AtlassianOAuthProvider

  /** The model-facing session: its tools are registered. */
  #model: McpSession | undefined
  /** The board's session; may be the same object as `#model`. */
  #board: McpSession | undefined
  #disposers = new Map<string, () => void>()
  /** Descriptions from the model session's `tools/list`. */
  #modelInfo: BridgedTool[] = []
  /** Descriptions from the board session's `tools/list`. */
  #boardInfo: BridgedTool[] = []
  #status: BridgeStatus = 'idle'
  #authorizationUrl: string | undefined
  #error: string | undefined
  #running: Promise<void> | undefined
  #testing: Promise<ConnectionTest> | undefined
  #disposed = false
  #waiters: Waiter[] = []
  /**
   * Bumped by every suspension.
   *
   * A run in flight checks it at each step and bails out silently, so a
   * disconnect that lands mid-connect can never be overwritten by the run it
   * interrupted — and can never leave tools registered behind it.
   */
  #epoch = 0

  constructor(host: BridgeHost, options: BridgeOptions) {
    this.#host = host
    this.#options = options
    this.#provider = new AtlassianOAuthProvider({
      // Resolved lazily: the callback server binds its port in `start()`, after
      // this constructor runs.
      redirectUri: () => this.#callback.redirectUri,
      store: options.store,
      logger: host.logger,
      onAuthorizationUrl: (url) => {
        this.#authorizationUrl = url
        this.#notify()
      },
    })
  }

  /**
   * Every raw MCP tool name the board can call, in discovery order.
   *
   * Diagnostics only: the Jira panel's tool lookup is pattern-based, and when a
   * pattern misses, this is the one thing that says whether the server renamed
   * a tool or authorized none at all.
   */
  rawNames(): readonly string[] {
    return [...(this.#board ?? this.#model)?.raw.values() ?? []]
  }

  /**
   * Everything either session listed, with the descriptions the server sent.
   *
   * The Settings page renders this as a searchable catalogue. `registered`
   * separates the tools the model pays context for from the board-only ones, so
   * a flat catalogue does not look like an accidentally huge context.
   */
  tools(): readonly BridgedTool[] {
    if (this.#board === undefined || this.#board === this.#model) return this.#modelInfo
    return [...this.#modelInfo, ...this.#boardInfo]
  }

  /**
   * The raw MCP name of a discovered tool, found by pattern over the raw names.
   *
   * The Jira panel reaches the same server the model does, but by capability
   * rather than by a hardcoded tool name: names carry a product prefix
   * (`searchJiraIssues…`) and could be renamed server-side, so matching a
   * fragment keeps the panel working while a literal name would silently rot.
   *
   * @param pattern - Case-insensitive fragment of the MCP tool name.
   * @returns The raw name to pass to `tools/call`, or undefined when absent.
   */
  rawNameMatching(pattern: RegExp): string | undefined {
    return findRawName(this.#board ?? this.#model, pattern)
  }

  /**
   * Call one discovered tool directly, without going through a model turn.
   *
   * Same connection, same authorization, same timeout, same error mapping the
   * model already gets. An MCP-level error rejects rather than resolving, so a
   * panel caller can never mistake a failure for data.
   *
   * @param rawName - Exact MCP tool name.
   * @param args - Tool arguments.
   * @param timeoutMs - Optional deadline override for a slow call.
   * @returns The MCP content blocks.
   */
  async callTool(
    rawName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<readonly unknown[]> {
    const session = this.#board ?? this.#model
    if (session === undefined || this.#status !== 'ready') {
      // A suspended bridge keeps its authorization, so the recovery is a click on
      // 重新连接 — not another browser round-trip. Saying "connect" would imply
      // the latter and make a deliberate toggle look like a broken login.
      throw new Error(
        this.#status === 'disconnected'
          ? 'Atlassian 已断开 — 到 设置 → Atlassian 点「重新连接」即可恢复（不需要再次授权）'
          : '未连接 Atlassian — 请先到 设置 → Atlassian 完成连接',
      )
    }
    const result = (await session.client.callTool({ name: rawName, arguments: args }, undefined, {
      timeout: timeoutMs ?? this.#options.toolCallTimeoutMs,
    })) as CallToolResult
    if (result.isError === true) throw new Error(extractText(result.content, rawName))
    return result.content
  }

  /**
   * Probe the live connection to answer "is this token still good?".
   *
   * A token can only be judged by the server that issued it, so this makes a
   * real authenticated request: the cheapest read-only tool that also touches
   * Atlassian's own APIs (`getAccessibleAtlassianResources`), falling back to
   * `atlassianUserInfo` and then to `tools/list`. That path is also why an
   * expired access token is usually invisible to the user — the transport sees
   * the 401, refreshes with the stored refresh token, and replays the call. The
   * probe reports that as `refreshed` rather than claiming nothing happened.
   *
   * When the credentials are rejected outright the local tokens are cleared and
   * the tools unregistered, so the page cannot keep claiming "connected" while
   * every call is doomed. Overlapping clicks share one probe.
   */
  async testConnection(): Promise<ConnectionTest> {
    const running = this.#testing ?? this.#probe()
    this.#testing = running
    try {
      return await running
    } finally {
      if (this.#testing === running) this.#testing = undefined
    }
  }

  async #probe(): Promise<ConnectionTest> {
    const started = Date.now()
    const checkedAt = new Date().toISOString()
    const result = (
      fields: Omit<ConnectionTest, 'checkedAt' | 'durationMs'>,
    ): ConnectionTest => ({ checkedAt, durationMs: Date.now() - started, ...fields })

    const client = (this.#model ?? this.#board)?.client
    if (client === undefined || this.#status !== 'ready') {
      return result({
        ok: false,
        verdict: 'not-connected',
        message: '当前没有已建立的连接，请先连接 Atlassian。',
      })
    }

    const before = this.#options.store.current.tokens?.access_token
    const probe =
      this.rawNameMatching(/accessibleatlassianresources/i) ??
      this.rawNameMatching(/atlassianuserinfo/i)
    let content: readonly unknown[] | undefined

    try {
      if (probe === undefined) {
        // No known read-only tool: still force one authenticated round-trip.
        await client.listTools()
      } else {
        const call = (await client.callTool({ name: probe, arguments: {} }, undefined, {
          timeout: PROBE_TIMEOUT_MS,
        })) as CallToolResult
        if (call.isError === true) {
          return result({
            ok: false,
            verdict: 'degraded',
            tool: probe,
            message: `令牌仍被 MCP 服务器接受，但探测工具返回错误：${clip(
              extractText(call.content, probe),
              400,
            )}`,
          })
        }
        content = call.content
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const signature = `${error instanceof Error ? error.name : ''} ${detail}`
      const status = httpStatus(error)

      if (error instanceof UnauthorizedError || isAuthFailure(signature, status)) {
        await this.#invalidate(signature)
        return result({
          ok: false,
          verdict: 'invalid',
          ...(probe === undefined ? {} : { tool: probe }),
          message: 'Atlassian 拒绝了当前令牌，本地授权已清除，请重新连接。',
        })
      }
      if (status === 403) {
        return result({
          ok: false,
          verdict: 'degraded',
          ...(probe === undefined ? {} : { tool: probe }),
          message: `令牌有效，但缺少访问权限（HTTP 403）：${clip(detail, 300)}`,
        })
      }
      if (status === 404) {
        // The credential was not refused; this is usually a stale MCP session
        // (or a moved endpoint), which a reconnect fixes.
        return result({
          ok: false,
          verdict: 'unknown',
          ...(probe === undefined ? {} : { tool: probe }),
          message: '服务器返回 404（MCP 会话或端点已失效），请点「断开连接」后重连。',
        })
      }
      return result({
        ok: false,
        verdict: 'unknown',
        ...(probe === undefined ? {} : { tool: probe }),
        message: `无法完成验证，连接状态未改变：${clip(detail, 300)}`,
      })
    }

    // A silent refresh is still a successful probe, but saying so is useful:
    // it explains why the first call after a long idle period is slow.
    const after = this.#options.store.current.tokens?.access_token
    const refreshed =
      typeof before === 'string' && typeof after === 'string' && before !== after
    const site = content === undefined ? undefined : siteFromResources(content)
    if (site !== undefined) await this.#options.store.patch({ site })
    const where = site === undefined ? '' : `，站点 ${site}`

    return result({
      ok: true,
      verdict: refreshed ? 'refreshed' : 'valid',
      tool: probe ?? 'tools/list',
      ...(site === undefined ? {} : { site }),
      message:
        probe === undefined
          ? `令牌有效（未找到可用的只读工具，只验证了 MCP 层${where}）。`
          : refreshed
            ? `访问令牌已过期，已自动用 refresh token 换到新令牌${where}。`
            : `令牌有效，探测工具调用成功${where}。`,
    })
  }

  /**
   * Drop credentials that the server has just refused.
   *
   * Tokens and the single-use PKCE verifier always go; the client registration
   * only when the authorization server blamed it, because otherwise it is still
   * the right registration for the next attempt.
   */
  async #invalidate(signature: string): Promise<void> {
    this.#host.logger.warn(`atlassian: token probe was rejected — ${clip(signature, 300)}`)
    await this.#teardownClient()
    this.#clearTools()
    this.#authorizationUrl = undefined
    if (/invalid_?client|unauthorized_?client/i.test(signature)) {
      await this.#options.store.clear('tokens', 'codeVerifier', 'clientInformation')
    } else {
      await this.#options.store.clear('tokens', 'codeVerifier')
    }
    this.#error = 'Atlassian 授权已失效，请重新连接。'
    this.#status = 'error'
    this.#notify()
  }

  /** A view for the Settings page. */
  snapshot(): BridgeSnapshot {
    const site = this.#options.store.current.site
    const expected = this.#options.expectedSite.trim().toLowerCase()
    return {
      status: this.#status,
      authorizationUrl: this.#authorizationUrl,
      site,
      siteMismatch:
        expected !== '' && site !== undefined && !site.toLowerCase().endsWith(expected.replace(/^https?:\/\//, '')),
      authorized: this.#options.store.current.tokens !== undefined,
      toolCount: this.#disposers.size,
      error: this.#error,
    }
  }

  /**
   * Bring the connection up, starting the OAuth flow if the server demands it.
   *
   * Never rejects for an authorization requirement: that is an ordinary state
   * (`authorizing`), not a failure — the user has to click something.
   *
   * No browser is opened here. Activation is a background event the user did
   * not ask for, and stealing focus with an authorization tab on every profile
   * start is worse than showing a link: the Settings page publishes the URL
   * and turns it into a click.
   */
  async start(): Promise<void> {
    if (this.#disposed) return
    await this.#options.store.load()
    await this.#callback.listen(this.#options.redirectPort)
    await this.#reconcileRedirectUri()
    // A suspension outlives the process on purpose: the user switched these
    // tools off, so activation must not put them back. `connect` clears the flag.
    if (this.#options.store.current.suspended === true) {
      this.#status = this.#options.store.current.tokens === undefined ? 'idle' : 'disconnected'
      this.#notify()
      return
    }
    this.#epoch += 1
    const epoch = this.#epoch
    this.#running = this.#run(false, epoch)
      .catch((error: unknown) => {
        this.#fail(error, epoch)
      })
      .finally(() => {
        if (this.#epoch === epoch) this.#running = undefined
        this.#notify()
      })
    await this.#waitUntil(() => this.#status !== 'connecting', 15_000)
  }

  /**
   * User-triggered connect, which doubles as "resume" after a suspension.
   *
   * Idempotent while a flow is already in flight, so a double click cannot start
   * two authorizations. A suspended bridge is resumed here: the stored tokens
   * are reused, so no browser is involved unless the server refuses them.
   */
  async authorize(): Promise<BridgeSnapshot> {
    if (this.#disposed) return this.snapshot()
    if (this.#status === 'ready') return this.snapshot()
    if (this.#status === 'authorizing' && this.#authorizationUrl !== undefined) {
      // The startup flow is already waiting on the callback; the click only
      // has to put the page in front of the user. Restarting the flow here
      // would discard a valid in-flight state and code verifier.
      await this.#openAuthorizationPage()
      return this.snapshot()
    }
    if (this.#running === undefined) {
      this.#error = undefined
      this.#authorizationUrl = undefined
      // The suspension is lifted before the run starts, so a crash mid-connect
      // leaves "wants to be connected" rather than a half-applied state.
      if (this.#options.store.current.suspended === true) {
        await this.#options.store.clear('suspended')
      }
      this.#epoch += 1
      const epoch = this.#epoch
      this.#running = this.#run(true, epoch)
        .catch((error: unknown) => {
          this.#fail(error, epoch)
        })
        .finally(() => {
          if (this.#epoch === epoch) this.#running = undefined
          this.#notify()
        })
    }
    // The authorization URL is published from inside `connect()`; a short wait
    // lets the button response carry it instead of forcing a poll.
    await this.#waitUntil(() => this.#authorizationUrl !== undefined || this.#status !== 'connecting', 20_000)
    return this.snapshot()
  }

  /**
   * Suspend the bridge: close both sessions and unregister every tool, but keep
   * the stored authorization.
   *
   * This is what the Settings page's 断开连接 button does. Signing the user out
   * is deliberately NOT its job: a suspended bridge has to be resumable without
   * a browser round-trip, so the tokens, the client registration and the site
   * all survive. The flag is persisted, so a harness restart does not silently
   * re-register the tools the user just switched off. {@link forget} is the
   * destructive counterpart.
   */
  async disconnect(): Promise<BridgeSnapshot> {
    // Bumping the epoch first is what makes this authoritative: a run that is
    // mid-connect when the click lands sees the change and bails out instead of
    // re-registering tools behind the suspension.
    this.#epoch += 1
    this.#running = undefined
    this.#callback.cancelWait()
    await this.#teardownClient()
    this.#clearTools()
    this.#authorizationUrl = undefined
    this.#error = undefined
    await this.#options.store.patch({ suspended: true })
    this.#status = this.#options.store.current.tokens === undefined ? 'idle' : 'disconnected'
    this.#notify()
    return this.snapshot()
  }

  /**
   * Sign out: drop the tools, the sessions, and the stored authorization.
   *
   * Kept separate from {@link disconnect} because the two mean different things
   * to the user — "switch the tools off for now" versus "forget this account".
   * Only this one forces a new browser authorization.
   */
  async forget(): Promise<BridgeSnapshot> {
    this.#epoch += 1
    this.#running = undefined
    this.#callback.cancelWait()
    await this.#teardownClient()
    this.#clearTools()
    this.#authorizationUrl = undefined
    this.#error = undefined
    await this.#options.store.destroy()
    this.#status = 'idle'
    this.#notify()
    return this.snapshot()
  }

  /** Stop the callback server, close the transport, unregister every tool. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#epoch += 1
    this.#running = undefined
    this.#callback.cancelWait()
    await this.#teardownClient()
    this.#clearTools()
    await this.#callback.close()
  }

  /** Unregister the current tool generation and forget its raw names. */
  #clearTools(): void {
    for (const dispose of this.#disposers.values()) dispose()
    this.#disposers = new Map()
    this.#modelInfo = []
    this.#boardInfo = []
  }

  /**
   * One connection lifecycle: connect, and — if the server demands
   * authorization — wait for the browser, exchange the code, and connect once
   * more with a fresh client.
   *
   * A second `UnauthorizedError` is not retried: at that point the code
   * exchange succeeded but the token was still refused, which no amount of
   * waiting will fix.
   *
   * The board's session is opened only after the model's is up, because the
   * authorization both of them use is resolved by the model connection first.
   * Its failure is not fatal: a broken panel must not cost the agent its tools.
   */
  async #run(openBrowser: boolean, epoch: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.#epoch !== epoch) return
      this.#status = 'connecting'
      this.#error = undefined
      this.#notify()

      const client = await this.#connect(openBrowser, attempt, () => {
        this.#status = 'authorizing'
        this.#notify()
      })
      // The click that suspended the bridge may have landed while the browser
      // flow was open. Registering the tools here would resurrect exactly what
      // the user switched off, so the new client is dropped instead.
      if (this.#epoch !== epoch) {
        if (client !== undefined) await client.close().catch(() => undefined)
        return
      }
      if (client === undefined) continue

      this.#model = { client, raw: new Map() }
      // Before `#syncTools`: the board session is what the tool catalogue is
      // enumerated from, so it has to exist first.
      await this.#connectBoard()
      if (this.#epoch !== epoch) {
        await this.#teardownClient()
        return
      }
      await this.#syncTools(this.#model)
      if (this.#epoch !== epoch) {
        await this.#teardownClient()
        this.#clearTools()
        return
      }
      await this.#detectSite(this.#model)
      this.#authorizationUrl = undefined
      this.#status = 'ready'
      this.#notify()
      this.#host.logger.info(
        `atlassian: connected to ${this.#options.url} — ${String(this.#disposers.size)} tool(s) registered` +
          (this.#board === this.#model
            ? ''
            : `, ${String(this.#board?.raw.size ?? 0)} board-only tool(s) from ${this.#options.boardUrl}`),
      )
      return
    }
    throw new Error('atlassian: authorization produced no usable connection')
  }

  /**
   * Connect one MCP session, running the browser flow once when the server
   * demands authorization.
   *
   * @param openBrowser - Whether to put the authorization page in front of the user.
   * @param attempt - Attempt index; only the first may authorize.
   * @param onAuthorize - Called as the flow starts, before the browser opens.
   * @returns The connected client, or undefined to retry after authorizing.
   */
  async #connect(
    openBrowser: boolean,
    attempt: number,
    onAuthorize: () => void,
  ): Promise<Client | undefined> {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
    const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), {
      authProvider: this.#provider,
    })
    try {
      await client.connect(transport)
      return client
    } catch (error) {
      await transport.close().catch(() => undefined)
      if (!(error instanceof UnauthorizedError) || attempt !== 0) throw error
      onAuthorize()
      if (openBrowser) await this.#openAuthorizationPage()
      const code = await this.#awaitAuthorizationCode()
      await auth(this.#provider, {
        serverUrl: this.#options.url,
        authorizationCode: code,
      })
      // The verifier is single-use; leaving it around would let a stale value be
      // replayed against a later authorization.
      await this.#options.store.clear('codeVerifier')
      return undefined
    }
  }

  /**
   * Open the board's session, unless the model's session already is it.
   *
   * Both URLs address the same OAuth resource, so the access token the model
   * connection just obtained is presented as-is; the SDK may still refresh it,
   * which writes back to the one shared store.
   */
  async #connectBoard(): Promise<void> {
    const model = this.#model
    if (model === undefined) return
    if (this.#options.boardUrl === this.#options.url) {
      this.#board = model
      return
    }

    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
    const transport = new StreamableHTTPClientTransport(new URL(this.#options.boardUrl), {
      authProvider: this.#provider,
    })
    try {
      await client.connect(transport)
    } catch (error) {
      await transport.close().catch(() => undefined)
      // The panel degrades to the model's catalogue instead of taking the
      // connection down with it; the missing-tool message it then shows is
      // actionable, and this line says why.
      this.#host.logger.warn(
        `atlassian: board catalogue ${this.#options.boardUrl} is unavailable (${error instanceof Error ? error.message : String(error)}) — the Jira panel will fall back to the model's tools`,
      )
      this.#board = model
      return
    }
    this.#board = { client, raw: new Map() }
  }

  /**
   * Enumerate the board session's tools, then register the model's.
   *
   * Listing the board catalogue is what makes the panel's pattern lookup work
   * against tools the model never sees; only the model's session is registered,
   * so only its definitions enter the model's context.
   */
  async #syncTools(model: McpSession): Promise<void> {
    const modelTools = await listAllTools(model.client)
    const definitions = new Map<string, ToolDefinition>()
    const info: BridgedTool[] = []
    for (const tool of modelTools) {
      const publicName = publicToolName(this.#options.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(
          `atlassian: server listed tool "${tool.name}" more than once — refusing an invalid tool list`,
        )
      }
      definitions.set(
        publicName,
        this.#makeDefinition(model.client, publicName, tool.name, tool.description, tool.inputSchema),
      )
      model.raw.set(publicName, tool.name)
      info.push({ name: publicName, rawName: tool.name, description: tool.description, registered: true })
    }

    // The board catalogue, when it is a different session. Every listed name is
    // recorded in `board.raw` — the panel calls primary tools through this
    // session too — but the display catalogue skips the ones already registered,
    // so the Settings page never shows one tool twice.
    const board = this.#board
    const boardInfo: BridgedTool[] = []
    if (board !== undefined && board !== model) {
      for (const tool of await listAllTools(board.client)) {
        const publicName = publicToolName(this.#options.serverName, tool.name)
        if (board.raw.has(publicName)) continue
        board.raw.set(publicName, tool.name)
        if (definitions.has(publicName)) continue
        boardInfo.push({
          name: publicName,
          rawName: tool.name,
          description: tool.description,
          registered: false,
        })
      }
    }

    for (const dispose of this.#disposers.values()) dispose()
    const next = new Map<string, () => void>()
    try {
      for (const [publicName, definition] of definitions) {
        next.set(publicName, this.#host.register(definition))
      }
    } catch (error) {
      for (const dispose of next.values()) dispose()
      throw new Error(`atlassian: tool registration failed, no tools registered: ${String(error)}`, {
        cause: error,
      })
    }
    this.#disposers = next
    this.#modelInfo = info
    this.#boardInfo = boardInfo
  }

  /**
   * Keep the stored client registration consistent with the bound port.
   *
   * Dynamic client registration pins the exact redirect URI, so if the port
   * moved — the preferred one was busy and the callback server fell back to an
   * ephemeral port — the stored `client_id` is bound to a URI this process can
   * no longer answer. Reusing it would fail at the redirect with an opaque
   * `redirect_uri` mismatch, so the registration is discarded up front and
   * re-created against the URI actually in use.
   */
  async #reconcileRedirectUri(): Promise<void> {
    const redirectUri = this.#callback.redirectUri
    const previous = this.#options.store.current.redirectUri
    if (previous !== undefined && previous !== redirectUri) {
      this.#host.logger.warn(
        `atlassian: OAuth redirect URI moved from ${previous} to ${redirectUri} — discarding the client registration and tokens bound to the old URI`,
      )
      await this.#options.store.clear('clientInformation', 'tokens', 'codeVerifier')
    }
    await this.#options.store.patch({ redirectUri })
  }

  /**
   * Put the authorization page in front of the user.
   *
   * Best-effort by design: the URL is always also published to the Settings
   * page and the log, so a host with no opener (a headless box, a locked-down
   * desktop) degrades to "click the link" instead of failing the flow.
   */
  async #openAuthorizationPage(): Promise<void> {
    const url = this.#authorizationUrl
    if (url === undefined || !this.#options.autoOpenBrowser) return
    const opened = await openInBrowser(url)
    if (!opened) {
      this.#host.logger.warn(
        `atlassian: could not open a browser automatically — open this URL manually: ${url}`,
      )
    }
  }

  /** Block until the loopback callback delivers an authorization code. */
  async #awaitAuthorizationCode(): Promise<string> {
    const url = this.#authorizationUrl
    // The state travels in the authorization URL; validating the redirect
    // against it here is what makes the code exchange CSRF-safe.
    const expectedState = url === undefined ? undefined : (new URL(url).searchParams.get('state') ?? undefined)
    const callback = await this.#callback.waitForCode(
      this.#options.authorizationTimeoutMs,
      expectedState,
    )
    return callback.code
  }

  /** Build one tool definition over the live client. */
  #makeDefinition(
    client: Client,
    publicName: string,
    rawName: string,
    description: string,
    parameters: unknown,
  ): ToolDefinition {
    const options = this.#options
    const definition = {
      name: publicName,
      description,
      parameters: parameters as ToolDefinition['parameters'],
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
          },
          required: ['content'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: unknown): ContentBlock[] => {
          const content = (value as { content?: unknown } | null)?.content
          return [{ type: 'text', text: extractText(content, rawName) }]
        },
      },
      execute: async (args: unknown, exec: { signal?: AbortSignal }): Promise<unknown> => {
        const result = (await client.callTool(
          {
            name: rawName,
            arguments: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
          },
          undefined,
          { timeout: options.toolCallTimeoutMs, signal: exec.signal },
        )) as CallToolResult
        // An MCP-level error must surface as a failed tool call: returning it
        // as a successful value would tell the model the call worked.
        if (result.isError === true) throw new Error(extractText(result.content, rawName))
        return { content: result.content }
      },
    }
    return definition as ToolDefinition
  }

  /**
   * Best-effort: ask the server which site was authorized.
   *
   * The authorization server never states the chosen site in the token, so the
   * only way to show it (and to catch a wrong-site authorization) is to call
   * the resources tool. This is intentionally non-fatal: a failure here costs
   * a site label, never the connection.
   */
  async #detectSite(session: McpSession): Promise<void> {
    const match = findRawName(session, /accessibleatlassianresources/i)
    if (match === undefined) return
    try {
      const result = (await session.client.callTool(
        { name: match, arguments: {} },
        undefined,
        { timeout: 20_000 },
      )) as CallToolResult
      if (result.isError === true) return
      const site = siteFromResources(result.content)
      if (site === undefined) return
      await this.#options.store.patch({ site })
      const expected = this.#options.expectedSite.trim()
      if (expected !== '' && !site.toLowerCase().endsWith(expected.toLowerCase().replace(/^https?:\/\//, ''))) {
        this.#host.logger.warn(
          `atlassian: authorized site "${site}" does not match the configured expectedSite "${expected}"`,
        )
      }
      this.#host.logger.info(`atlassian: authorized site ${site} (via ${match})`)
    } catch {
      // Site detection is cosmetic; the connection stands without it.
    }
  }

  /** Close both sessions; a shared one is closed once. */
  async #teardownClient(): Promise<void> {
    const model = this.#model
    const board = this.#board
    this.#model = undefined
    this.#board = undefined
    const clients = board === undefined || board === model ? [model] : [model, board]
    for (const session of clients) {
      if (session === undefined) continue
      try {
        await session.client.close()
      } catch {
        // Closing a dead transport is not an error worth surfacing.
      }
    }
  }

  /**
   * Record a failed run.
   *
   * A failure from a superseded run is discarded: the user already suspended or
   * replaced that attempt, and surfacing its error would paint a red banner over
   * a state they deliberately chose.
   */
  #fail(error: unknown, epoch: number): void {
    if (this.#epoch !== epoch) return
    this.#error = error instanceof Error ? error.message : String(error)
    this.#status = 'error'
    this.#host.logger.error(`atlassian: ${this.#error}`)
    this.#notify()
  }

  #notify(): void {
    const remaining: Waiter[] = []
    for (const waiter of this.#waiters) {
      if (waiter.predicate()) waiter.settle()
      else remaining.push(waiter)
    }
    this.#waiters = remaining
  }

  #waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const waiter = {
        predicate,
        settle: (): void => {
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        },
      }
      timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter)
        resolve()
      }, timeoutMs)
      timer.unref()
      this.#waiters.push(waiter)
    })
  }
}

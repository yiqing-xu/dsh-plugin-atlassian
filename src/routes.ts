import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AtlassianBridge, BridgeSnapshot } from './bridge.js'
import { BoardError, type JiraBoard } from './board.js'
import type { PreferenceStore } from './prefs.js'

/** Everything the Settings page and the Jira board talk to lives under this prefix. */
export const ROUTE_PREFIX = '/plugins/atlassian'

/** The `webServer` service face this plugin needs (typed structurally). */
export interface RouteRegistrar {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * The host `connection` service's request fence.
 *
 * Present in web profiles: it rejects cross-site and unauthenticated callers
 * by Host/Origin and the browser login cookie. These routes are reached only
 * from the settings page and the board panel — both same-origin UI — so the
 * fence is exactly right for them, and the plugin must still work without it.
 */
export interface RequestFence {
  requestRejection(req: IncomingMessage): number | undefined
}

/** The board settings the endpoints enforce and the panel reads. */
export interface BoardRouteOptions {
  /** Deployment default JQL, used when a request does not override it. */
  jql: string
  /** Issues fetched per refresh. */
  limit: number
  /** Deadline for one board read. */
  timeoutMs: number
  /** Instruction template for a hand-over; empty selects the built-in one. */
  promptTemplate: string
  /**
   * Custom-field id backing the sprint field, when the site does not use the
   * default `sprint` name. Empty asks for the well-known field only.
   */
  sprintField: string
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** The Settings page's wire shape. */
interface StatusBody extends Omit<BridgeSnapshot, 'siteMismatch'> {
  siteMismatch: boolean
  ok: boolean
  /** Deployment board defaults, so the panel never hardcodes its own copy. */
  board: Pick<BoardRouteOptions, 'jql' | 'limit' | 'promptTemplate'>
}

function body(bridge: AtlassianBridge, ok: boolean, options: BoardRouteOptions): StatusBody {
  return {
    ...bridge.snapshot(),
    ok,
    board: { jql: options.jql, limit: options.limit, promptTemplate: options.promptTemplate },
  }
}

/** A ceiling on request bodies: every one of them is a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read and parse a JSON request body.
 *
 * Bounded on purpose: the route is reachable from the page, and an unbounded
 * `for await` over `req` would let one request hold as much memory as it likes.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BoardError('too-large', '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BoardError('bad-request', '请求体必须是一个 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** A required non-empty string field of a request body. */
function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BoardError('bad-request', `缺少字段 ${field}`)
  }
  return value
}

/**
 * Register this plugin's HTTP endpoints behind one prefix route.
 *
 * Path shapes:
 * - `GET  /status`, `POST /connect`, `POST /disconnect` — the Settings page.
 * - `POST /forget` — sign out: drop the stored authorization, not just the tools.
 * - `POST /test` — probe whether the current token is still accepted.
 * - `GET  /tools` — every registered tool with its server-supplied description.
 * - `GET  /prefs`, `POST /prefs` — the UI preferences document.
 * - `GET  /board?jql=` — issues for the board, grouped client-side.
 * - `GET  /projects` — projects the authorization can see.
 * - `GET  /sprints?project=` — every sprint that project's boards offer.
 * - `GET  /issue/<key>` — one issue with its description.
 * - `GET  /issue/<key>/transitions` — transitions currently offered.
 * - `POST /transition` — apply one transition by id.
 *
 * @param web - The composition's web server service.
 * @param bridge - The connection the Settings endpoints drive.
 * @param board - The Jira projection the board endpoints read.
 * @param options - Deployment defaults for board reads.
 * @param prefs - The persisted UI preferences the Settings switch edits.
 * @param fence - Optional request fence, when the `connection` service exists.
 * @returns A disposer that unregisters the route.
 *
 * Also serves `GET /debug-tools`: the raw MCP tool names this connection
 * discovered, which is the only way to tell a renamed tool from an
 * authorization that granted no Jira product.
 */
export function registerRoutes(
  web: RouteRegistrar,
  bridge: AtlassianBridge,
  board: JiraBoard,
  options: BoardRouteOptions,
  prefs: PreferenceStore,
  fence: RequestFence | undefined,
): () => void {
  return web.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (fence !== undefined) {
        const rejection = fence.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
      }

      const url = new URL(String(req.url), 'http://localhost')
      const pathname = url.pathname
      const action = pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
      const method = req.method ?? 'GET'

      try {
        if (action === 'status' && method === 'GET') {
          sendJson(res, 200, body(bridge, true, options))
          return
        }
        if (action === 'connect' && method === 'POST') {
          const snapshot = await bridge.authorize()
          sendJson(res, 200, { ...snapshot, ok: true })
          return
        }
        if (action === 'disconnect' && method === 'POST') {
          // Suspends, does not sign out: the tools leave the model's context and
          // the stored authorization stays, so a later `connect` is silent.
          const snapshot = await bridge.disconnect()
          sendJson(res, 200, { ...snapshot, ok: true })
          return
        }
        if (action === 'forget' && method === 'POST') {
          const snapshot = await bridge.forget()
          sendJson(res, 200, { ...snapshot, ok: true })
          return
        }
        if (action === 'test' && method === 'POST') {
          // Always 200 with the verdict in the body: "the token is dead" is a
          // successful measurement, not a failed request. The page renders the
          // verdict instead of turning it into a generic transport error.
          const test = await bridge.testConnection()
          sendJson(res, 200, { ok: true, test })
          return
        }
        if (action === 'tools' && method === 'GET') {
          // The Settings page's tool browser. Descriptions are large but this
          // is a per-page load, not something the status poll carries.
          sendJson(res, 200, { ok: true, tools: bridge.tools() })
          return
        }
        if (action === 'prefs' && method === 'GET') {
          // The sidebar switch. Read on every page load: the host document is
          // the source of truth, so two browsers on one profile agree.
          sendJson(res, 200, { ok: true, prefs: await prefs.load() })
          return
        }
        if (action === 'prefs' && method === 'POST') {
          const input = await readJsonBody(req)
          // Both fields are optional so one switch can be written without
          // restating the other, but a field that IS present must be exactly
          // the shape it claims to be: `"false"` is a caller bug, and storing
          // it as `true` would silently ignore the switch that sent it.
          const patch: { panelVisible?: boolean; pinnedProjects?: string[]; recentProjects?: string[] } = {}
          if (input['panelVisible'] !== undefined) {
            if (typeof input['panelVisible'] !== 'boolean') {
              throw new BoardError('bad-request', 'panelVisible 必须是布尔值')
            }
            patch.panelVisible = input['panelVisible']
          }
          if (input['pinnedProjects'] !== undefined) {
            const pinned = input['pinnedProjects']
            if (!Array.isArray(pinned) || pinned.some((entry) => typeof entry !== 'string')) {
              throw new BoardError('bad-request', 'pinnedProjects 必须是字符串数组')
            }
            patch.pinnedProjects = pinned as string[]
          }
          if (input['recentProjects'] !== undefined) {
            const recent = input['recentProjects']
            if (!Array.isArray(recent) || recent.some((entry) => typeof entry !== 'string')) {
              throw new BoardError('bad-request', 'recentProjects 必须是字符串数组')
            }
            patch.recentProjects = recent as string[]
          }
          if (
            patch.panelVisible === undefined &&
            patch.pinnedProjects === undefined &&
            patch.recentProjects === undefined
          ) {
            throw new BoardError('bad-request', '缺少字段 panelVisible、pinnedProjects 或 recentProjects')
          }
          sendJson(res, 200, { ok: true, prefs: await prefs.patch(patch) })
          return
        }
        if (action === 'debug-tools' && method === 'GET') {
          // Diagnostics for the board's pattern-based lookup: when a pattern
          // misses, this is what distinguishes "renamed server-side" from
          // "authorized no Jira at all".
          sendJson(res, 200, { ok: true, names: bridge.rawNames() })
          return
        }

        if (action === 'board' && method === 'GET') {
          const requested = url.searchParams.get('jql')
          const payload = await board.load({
            jql: requested === null ? options.jql : requested,
            limit: options.limit,
            timeoutMs: options.timeoutMs,
            sprintField: options.sprintField,
          })
          sendJson(res, 200, { ok: true, ...payload, limit: options.limit })
          return
        }
        if (action === 'projects' && method === 'GET') {
          const projects = await board.projects(options.timeoutMs)
          sendJson(res, 200, { ok: true, projects })
          return
        }
        // A project's sprint CATALOGUE — every sprint its boards offer, closed
        // ones included. The panel's sprint row is built from this, not from the
        // sprints the current page happens to show.
        if (action === 'sprints' && method === 'GET') {
          const project = (url.searchParams.get('project') ?? '').trim()
          if (project === '') throw new BoardError('bad-request', '缺少 project 参数')
          const sprints = await board.sprints(project, options.timeoutMs)
          sendJson(res, 200, { ok: true, project, sprints })
          return
        }
        if (action === 'transition' && method === 'POST') {
          const input = await readJsonBody(req)
          const key = requireString(input, 'key')
          const transitionId = requireString(input, 'transitionId')
          await board.transition(key, transitionId, options.timeoutMs)
          sendJson(res, 200, { ok: true })
          return
        }

        const issueMatch = /^issue\/([^/]+)$/.exec(action)
        if (issueMatch !== null && method === 'GET') {
          const key = decodeURIComponent(issueMatch[1] ?? '')
          const detail = await board.detail(key, options.timeoutMs, options.sprintField)
          sendJson(res, 200, { ok: true, ...detail })
          return
        }
        const transitionMatch = /^issue\/([^/]+)\/transitions$/.exec(action)
        if (transitionMatch !== null && method === 'GET') {
          const key = decodeURIComponent(transitionMatch[1] ?? '')
          const transitions = await board.transitions(key, options.timeoutMs)
          sendJson(res, 200, { ok: true, transitions })
          return
        }

        sendJson(res, 404, { ok: false, error: `unknown endpoint: ${method} ${pathname}` })
      } catch (error) {
        if (error instanceof BoardError) {
          sendJson(res, 400, { ok: false, code: error.code, error: error.message })
          return
        }
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}

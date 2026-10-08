import * as React from 'react'

/**
 * The browser half of dsh-plugin-atlassian.
 *
 * Two surfaces, both owned by this one file:
 *
 * - **Settings → Atlassian**: the OAuth connection page.
 * - **The Jira board**: a `sidebar.panellist` entry plus the keyed `main` panel
 *   it addresses, projecting the same MCP connection the agent already uses.
 *   An issue can be handed to an agent without retyping any of it.
 *
 * This file is compiled on its own (`tsconfig.client.json`) into CommonJS and
 * wrapped by `scripts/bundle-client.mjs` into the runtime's
 * `window.__ModuleLoader__.load` closure-factory. That is why it must stay a
 * SINGLE file with no relative imports: a relative `require('./x.js')` would be
 * resolved by the browser module loader, not by this package.
 *
 * Everything is built with `React.createElement` rather than JSX: a client half
 * is plain JavaScript in the browser, and a factory that hoists its own styles
 * must run at materialization time, so the explicit form is the portable one.
 */

/** Endpoints the host half serves. Must match `src/routes.ts`. */
const ROUTE_PREFIX = '/plugins/atlassian'

/** Settings section label. Used for the registration AND to find the nav row. */
const SECTION_LABEL = 'Atlassian'

/** Main-panel key. Also the `sidebar.panellist` id that selects it. */
const PANEL_ID = 'jira-board'

const LI = React.createElement

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Visual values are expressed as shell CSS variables with a literal fallback,
 * so the panel reads correctly in light and dark without shipping a palette of
 * its own and without depending on a token that may not exist yet at first
 * paint.
 */
function tok(name: string, fallback: string): string {
  return `var(--${name}, ${fallback})`
}

const C = {
  text: tok('text', '#1f2328'),
  textDim: tok('text-secondary', 'rgba(127,127,127,.95)'),
  textFaint: tok('text-tertiary', 'rgba(127,127,127,.72)'),
  border: tok('border', 'rgba(127,127,127,.28)'),
  borderSoft: tok('border-subtle', 'rgba(127,127,127,.18)'),
  surface: tok('surface', '#ffffff'),
  surfaceSoft: tok('surface-subtle', 'rgba(127,127,127,.06)'),
  surfaceHover: tok('surface-hover', 'rgba(127,127,127,.10)'),
  accent: tok('accent', '#2f6fed'),
  accentSoft: tok('accent-subtle', 'rgba(47,111,237,.12)'),
} as const

const TONE_COLOR: Record<string, string> = {
  neutral: 'rgba(127,127,127,.9)',
  pending: '#c98a00',
  ok: '#1a9e5c',
  bad: '#d64545',
}

const box: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: '14px 16px',
  marginBottom: 14,
}

const button: React.CSSProperties = {
  border: '1px solid rgba(127,127,127,.35)',
  borderRadius: 8,
  padding: '6px 14px',
  fontSize: '0.9em',
  cursor: 'pointer',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

/** A compact control: the board's toolbar and drawer use these. */
const chip: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  padding: '3px 9px',
  fontSize: '0.82em',
  cursor: 'pointer',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

const input: React.CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: '0.86em',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  minWidth: 0,
}

/**
 * The board's own stylesheet, emitted at materialization time.
 *
 * `dsh-client-modules` claims the `<style>` tags a factory injects during
 * materialization and adopts them for HMR bookkeeping, so a tag written here —
 * not from inside `apply` — is the form the module system actually owns.
 */
if (typeof document !== 'undefined') {
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', 'dsh-plugin-atlassian')
  tag.textContent = `
[data-dsh-jira-board] { color: ${C.text}; }
[data-dsh-jira-board] *, [data-dsh-jira-board] *::before, [data-dsh-jira-board] *::after { box-sizing: border-box; }
[data-dsh-jira-card] { transition: border-color .12s ease, background-color .12s ease; }
[data-dsh-jira-card]:hover { border-color: ${C.accent} !important; }
[data-dsh-jira-card][data-dragging="1"] { opacity: .45; }
[data-dsh-jira-cols] { scrollbar-width: thin; }
[data-dsh-jira-cols]::-webkit-scrollbar { height: 8px; }
[data-dsh-jira-cols]::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 999px; }
[data-dsh-jira-drop="1"] { outline: 2px dashed ${C.accent} !important; outline-offset: 1px; }
[data-dsh-jira-md] > *:first-child { margin-top: 0; }
[data-dsh-jira-md] > *:last-child { margin-bottom: 0; }
[data-dsh-jira-md] a { text-decoration: underline; }
`
  document.head.appendChild(tag)
}

// ---------------------------------------------------------------------------
// Wire types (a structural mirror of the host half)
// ---------------------------------------------------------------------------

type Status = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'

interface StatusPayload {
  ok: boolean
  status: Status
  authorizationUrl?: string
  site?: string
  siteMismatch: boolean
  toolCount: number
  error?: string
  board: { jql: string; limit: number; promptTemplate: string }
}

interface BoardStatusInfo {
  name: string
  categoryKey: string
  categoryName: string
  colorName: string
}

interface BoardIssue {
  key: string
  id: string
  summary: string
  status: BoardStatusInfo
  type: string
  priority?: string
  assignee?: string
  reporter?: string
  updated?: string
  projectKey?: string
  projectName?: string
  url?: string
}

interface BoardTransition {
  id: string
  name: string
  toName: string
  toCategoryKey: string
}

interface BoardPayload {
  ok: boolean
  issues: BoardIssue[]
  constrained: boolean
  jql: string
  site?: string
  truncated: boolean
  limit: number
}

interface DetailPayload {
  ok: boolean
  issue: BoardIssue
  description: string
}

interface TransitionsPayload {
  ok: boolean
  transitions: BoardTransition[]
  error?: string
}

/** A failed call, carrying the host's own code when it sent one. */
class ApiError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

async function api<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let payload: unknown
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new ApiError(`HTTP ${String(response.status)}: ${text.slice(0, 200)}`)
  }
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  if (!response.ok || record['ok'] === false) {
    throw new ApiError(
      typeof record['error'] === 'string' ? record['error'] : `HTTP ${String(response.status)}`,
      typeof record['code'] === 'string' ? record['code'] : undefined,
    )
  }
  return payload as T
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<Status, string> = {
  idle: '未连接',
  connecting: '连接中…',
  // Not "waiting for the browser": activation runs a background attempt that
  // turns out to need authorization, and no tab has been opened at that point.
  authorizing: '需要授权',
  ready: '已连接',
  error: '出错',
}

function Badge({ status }: { status: Status }): React.ReactElement {
  const tone =
    status === 'ready'
      ? 'ok'
      : status === 'connecting' || status === 'authorizing'
        ? 'pending'
        : status === 'error'
          ? 'bad'
          : 'neutral'
  const color = TONE_COLOR[tone] ?? TONE_COLOR['neutral']
  return LI(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85em', color, fontWeight: 600 } },
    LI('span', {
      key: 'dot',
      style: { width: 8, height: 8, borderRadius: 999, background: color, display: 'inline-block' },
    }),
    STATUS_TEXT[status],
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return LI(
    'div',
    { style: { display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.9em' } },
    LI('span', { key: 'label', style: { minWidth: 96, opacity: 0.65 } }, label),
    LI('span', { key: 'value', style: { wordBreak: 'break-all' } }, children),
  )
}

/**
 * The mark's geometry, shared by the React header, the board panel, and the
 * nav-glyph patch so the three can never drift apart.
 *
 * It is a link, not the Atlassian logo: this is an unofficial bridge, the mark
 * has to read at 16px, and drawing someone's trademark into a third-party
 * plugin's chrome is a licensing question nobody needs.
 */
const MARK_PATHS = [
  'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
  'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
]

/** Marker attribute so the nav patch never re-wraps its own output. */
const GLYPH_FLAG = 'data-dsh-atlassian-glyph'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Build the nav glyph as a detached SVG element.
 *
 * Through the DOM rather than by parsing an HTML string: an `<svg>` only
 * becomes an SVG-namespaced element when the parser knows it is in SVG
 * context, and `innerHTML` on a `<div>` silently produces an inert HTML
 * element that renders as nothing.
 */
function navGlyph(): Element {
  const doc = document.implementation.createDocument(SVG_NS, 'svg', null)
  const svg = doc.documentElement
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute(GLYPH_FLAG, '1')
  for (const d of MARK_PATHS) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

function Mark({ size = 18 }: { size?: number }): React.ReactElement {
  return LI(
    'span',
    {
      'aria-hidden': 'true',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size * 1.9,
        height: size * 1.9,
        flex: 'none',
        borderRadius: 9,
        border: `1px solid ${C.border}`,
      },
    },
    LI(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      MARK_PATHS.map((d) => LI('path', { key: d, d })),
    ),
  )
}

// ---------------------------------------------------------------------------
// Client context
// ---------------------------------------------------------------------------

/** The client context surface this half uses (typed structurally). */
interface ClientContext {
  get?(service: string): unknown
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown
  }
}

interface LayoutService {
  selectPanel?(panelId: string | null): void
}

interface SessionsService {
  /**
   * The business Session behind one session id, or undefined when it is not
   * currently materialized.
   *
   * This — not `scope(id).remote` — is how a prompt reaches a session. The
   * scoped context is a no-op fiber with no `inject`, so Cordis's proxy rejects
   * service *property* access on it (`cannot get property "remote" without
   * inject`). The binding hands back the Session object itself, which is what
   * the shipped composer delivers through.
   */
  binding?(id: string): { session?: SessionDelivery } | undefined
  /**
   * Retain a session for the duration of one operation, materializing it on
   * demand. Absent on 0.1.x, where `binding()` itself materializes.
   */
  using?<T>(
    target: string,
    options: { source: string },
    operation: (reference: { binding?: { session?: SessionDelivery } }) => Promise<T>,
  ): Promise<T>
  open?(id: string): void
}

/** The Session face that admits one prompt. */
interface SessionDelivery {
  prompt?: (
    content: readonly { type: 'text'; text: string }[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ) => Promise<unknown>
}

interface UiWorkspaceService {
  connectWorkspace(workspaceId: string): Promise<string>
  startSession(workspaceId?: string): void
  openSession?(sessionId: string): void
}

interface WorkspacesService {
  list: {
    getSnapshot(): {
      items: readonly { workspaceId: string; path: string; title: string; sessionIds: readonly string[] }[]
    }
  }
}

/**
 * One entry of the sessions-service list snapshot (the fields the UI reads).
 *
 * `retainedBy` and `current` are rivals rather than companions: 0.2.0 replaced
 * the snapshot's single `current` id with per-row live retention counts. Both
 * are optional here so this half runs on either harness.
 */
interface SessionSummary {
  id: string
  displayTitle: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  cwd?: string
  /** Live retention counts per source; `mainView` is the session on stage. */
  retainedBy?: { mainView?: number }
}

interface SessionsListService {
  list: {
    getSnapshot(): {
      ids: readonly string[]
      byId: Record<string, SessionSummary | undefined>
      /** Pre-0.2.0 single current-session id. */
      current?: string
    }
  }
}

/**
 * The session the shell currently shows in its main view.
 *
 * 0.2.0 dropped the list snapshot's `current` field; the live fact now rides the
 * per-row retention counts, and `mainView > 0` is exactly what the shell itself
 * reads to decide which session is on stage. `current` remains the answer on
 * 0.1.x, where retention counts do not exist yet. Returning `undefined` keeps
 * every caller on its existing "no current session" path.
 */
function currentSessionId(service: SessionsListService | undefined): string | undefined {
  const snapshot = service?.list.getSnapshot()
  if (snapshot === undefined) return undefined
  return (
    snapshot.current ??
    Object.values(snapshot.byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id
  )
}

/** A workspace plus the sessions it groups, for the hand-over menu. */
interface WorkspaceChoice {
  workspaceId: string
  title: string
  path: string
  sessions: readonly SessionSummary[]
}

/**
 * The live context, published for slot components.
 *
 * `apply` receives the context but a slot component is constructed by the
 * runtime, so it is handed over through a provider rather than through props.
 */
const ContextRef = React.createContext<ClientContext>({
  slots: { inject: () => () => undefined, register: () => undefined },
})

/** Services for a hand-over, resolved once per panel mount. */
function useHandover(): {
  ctx: ClientContext
  sessions: SessionsService | undefined
  sessionsList: SessionsListService | undefined
  uiWorkspace: UiWorkspaceService | undefined
  workspaces: WorkspacesService | undefined
  layout: LayoutService | undefined
} {
  const ctx = React.useContext(ContextRef)
  return React.useMemo(
    () => ({
      ctx,
      sessions: ctx.get?.('sessions') as SessionsService | undefined,
      sessionsList: ctx.get?.('sessions') as SessionsListService | undefined,
      uiWorkspace: ctx.get?.('uiWorkspace') as UiWorkspaceService | undefined,
      workspaces: ctx.get?.('workspaces') as WorkspacesService | undefined,
      layout: ctx.get?.('layout') as LayoutService | undefined,
    }),
    [ctx],
  )
}

// ---------------------------------------------------------------------------
// Hand-over: turning one issue into one agent turn
// ---------------------------------------------------------------------------

/**
 * The instruction handed to an agent for one or more issues.
 *
 * Batches are rendered as one list under a single set of requirements: sending
 * three issues as three separate prompts in one session would interleave them
 * into an unattributable mess, and the agent would have no way to say which
 * issue a change belongs to.
 */
function buildPrompt(issues: readonly BoardIssue[], template: string): string {
  const plural = issues.length > 1
  const fallback = [
    plural ? `请开发这 ${String(issues.length)} 个 Jira 任务：` : '请开发这个 Jira 任务：',
    '',
    ...issues.map((issue) => `- {{key}} · {{summary}}`.replace('{{key}}', issue.key).replace('{{summary}}', issue.summary)),
    '',
    '要求：',
    '1. 先读代码库确认现状，再动手；不要凭任务描述臆测实现。',
    plural
      ? '2. 逐个任务处理，每个任务一个独立回合，说明是哪一个工单的改动。'
      : '2. 只做这个任务范围内的改动，不要顺手重构无关代码。',
    '3. 完成后给出可复核的证据（改动的文件、跑过的命令与结果、必要的测试）。',
    '4. 收尾时告诉我：做完了什么、验证了什么、还有什么没做。',
    '5. 不要自行变更 Jira 工单状态 —— 状态流转由我在看板上确认。',
    '',
    '如果需要我补信息或做决定，先停下来问我。',
  ].join('\n')

  if (template.trim() === '') return fallback

  // A custom template is written for ONE issue, so a batch gets one copy per
  // issue: interpolating a list into `{{key}}` would silently produce a prompt
  // that names only the first one.
  return issues
    .map((issue) => template.replace(/\{\{key\}\}/g, issue.key).replace(/\{\{summary\}\}/g, issue.summary))
    .join('\n\n---\n\n')
}

/** Where a hand-over should land. */
type HandOverTarget =
  /** A blank session in this workspace, or in the current/most recent one. */
  | { kind: 'new-session'; workspaceId?: string | undefined }
  /** The session that is open right now. */
  | { kind: 'current-session' }
  /** One exact, already existing session. */
  | { kind: 'session'; sessionId: string; label?: string | undefined }

/** A short "PROJ-1, PROJ-2 等 3 个" style subject for messages. */
function subjectOf(issues: readonly BoardIssue[]): string {
  if (issues.length === 1) return issues[0]?.key ?? '工单'
  const first = issues[0]?.key ?? ''
  return `${first} 等 ${String(issues.length)} 个`
}

/** Create a session for a hand-over and return its id. */
async function createHandoverSession(
  uiWorkspace: UiWorkspaceService | undefined,
  workspaces: WorkspacesService | undefined,
  sessionsList: SessionsListService | undefined,
  workspaceId: string | undefined,
): Promise<string | undefined> {
  if (uiWorkspace !== undefined && workspaces !== undefined) {
    const snapshot = workspaces.list.getSnapshot()
    const current = currentSessionId(sessionsList)
    const host =
      // An explicit workspace wins; otherwise the one owning the open session,
      // and only then the first registered one.
      (workspaceId === undefined ? undefined : snapshot.items.find((item) => item.workspaceId === workspaceId)) ??
      snapshot.items.find((item) => (current === undefined ? false : item.sessionIds.includes(current))) ??
      snapshot.items[0]
    if (host !== undefined) {
      // Deliberately NOT opening the session here. Navigating would unmount the
      // board, which destroys the confirmation the user needs and makes a second
      // hand-over impossible without navigating back. The prompt is already
      // queued; the session is one click away in the sidebar.
      return await uiWorkspace.connectWorkspace(host.workspaceId)
    }
  }
  // No workspace to attach to: fall back to the shell's own new-session flow,
  // which cannot report an id — the caller is told the prompt was not sent.
  uiWorkspace?.startSession(workspaceId)
  return undefined
}

/**
 * Deliver one prompt to an existing session.
 *
 * The Session object — not a scoped context — is the delivery channel. The
 * scoped context is a no-op fiber that declares no `inject`, and Cordis gates
 * service *property* access on such a context, so the previous
 * `scope(id).remote.session` lookup could only ever throw. `binding()` returns
 * the Session itself, which is what the shipped composer sends through.
 *
 * `using()` retains the session for the call, materializing a session that is
 * not currently on stage; 0.2.0 dropped the on-demand materialization that
 * `binding()` alone used to get from `resolve()`. Where `using()` is absent
 * (0.1.x) the plain binding still covers the listed cases.
 */
async function deliverPrompt(
  sessions: SessionsService | undefined,
  sessionId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (sessions === undefined) return { ok: false, error: '会话服务不可用' }
  const content = [{ type: 'text', text }] as const
  const requestId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`

  // The result is shaped `{ ok, value }` / `{ ok: false, error }`; a session
  // face that ignores the contract resolves undefined and counts as delivered.
  const interpret = (result: unknown): { ok: boolean; error?: string } => {
    const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined
    if (record === undefined || record['ok'] !== false) return { ok: true }
    const error = record['error']
    const message =
      typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string'
        ? String((error as Record<string, unknown>)['message'])
        : '投递被拒绝'
    return { ok: false, error: message }
  }

  /** Send through one binding, or report that it carries no session face. */
  const send = async (binding: { session?: SessionDelivery } | undefined): Promise<{ ok: boolean; error?: string }> => {
    const prompt = binding?.session?.prompt
    if (prompt === undefined) return { ok: false, error: '拿不到这个会话的投递通道' }
    return interpret(
      await prompt.call(binding?.session, content, 'queue', undefined, requestId),
    )
  }

  if (typeof sessions.using === 'function') {
    try {
      return await sessions.using(sessionId, { source: 'board-handover' }, (reference) => send(reference?.binding))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return await send(sessions.binding?.(sessionId))
}

/**
 * Hand one or more issues over to an agent.
 *
 * The target is explicit because "where did that prompt go" is the whole
 * question this feature has to answer, and because composing a prompt and
 * starting unattended work are different levels of trust. No Jira write happens
 * here — the agent is told explicitly not to touch the workflow, and the
 * board's transition menu is the only writer.
 */
async function handOver(
  services: ReturnType<typeof useHandover>,
  issues: readonly BoardIssue[],
  promptTemplate: string,
  target: HandOverTarget,
): Promise<{ ok: boolean; message: string; sessionId?: string }> {
  if (issues.length === 0) return { ok: false, message: '没有选中任何工单' }
  const text = buildPrompt(issues, promptTemplate)
  const subject = subjectOf(issues)

  if (target.kind === 'current-session') {
    const current = currentSessionId(services.sessionsList)
    if (current === undefined) return { ok: false, message: '当前没有打开的会话 —— 改用「新会话」' }
    const delivered = await deliverPrompt(services.sessions, current, text)
    return delivered.ok
      ? { ok: true, message: `${subject} 已投递到当前会话`, sessionId: current }
      : { ok: false, message: delivered.error ?? '投递失败' }
  }

  if (target.kind === 'session') {
    const delivered = await deliverPrompt(services.sessions, target.sessionId, text)
    const where = target.label ?? '所选会话'
    if (!delivered.ok) return { ok: false, message: `投递到「${where}」失败：${delivered.error ?? '未知原因'}` }
    // No navigation: staying on the board keeps the confirmation visible and
    // lets the user hand over another issue without losing their place.
    return { ok: true, message: `${subject} 已投递到「${where}」`, sessionId: target.sessionId }
  }

  try {
    const sessionId = await createHandoverSession(
      services.uiWorkspace,
      services.workspaces,
      services.sessionsList,
      target.workspaceId,
    )
    if (sessionId === undefined) {
      return { ok: false, message: '已开新会话，但拿不到它的 id：提示词没有自动送入，请用「复制提示词」' }
    }
    const delivered = await deliverPrompt(services.sessions, sessionId, text)
    return delivered.ok
      ? { ok: true, message: `${subject} 已交给新会话`, sessionId }
      : { ok: false, message: `会话已建好，但投递失败：${delivered.error ?? '未知原因'}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Drag payload MIME shared by the board cards and the panel icon. */
const DRAG_MIME = 'application/x-dsh-jira-issue'

/**
 * Workspaces and the sessions each one groups, for the hand-over menu.
 *
 * Assembled from the two client stores rather than from the DOM: the sidebar
 * tree carries no stable per-session marker, so reading it would mean matching
 * on rendered (and truncated) titles — exactly the kind of guess that hands work
 * to the wrong conversation.
 *
 * The lists are re-read on demand (menu open, plus a slow tick while one is
 * open) instead of through a `subscribe` call. Their store objects expose
 * `getSnapshot`/`update`/`set`; the observer API is not part of the documented
 * service face, and assuming it was produced a crash that took the whole panel
 * down with it.
 */
function useWorkspaceChoices(active: boolean): {
  choices: readonly WorkspaceChoice[]
  refresh: () => void
} {
  const { sessionsList, workspaces } = useHandover()
  const [tick, setTick] = React.useState(0)

  const refresh = React.useCallback((): void => {
    setTick((current) => current + 1)
  }, [])

  // While the menu is open a session may start or finish underneath it; a slow
  // re-read keeps the labels honest without a subscription to reason about.
  React.useEffect(() => {
    if (!active) return
    const handle = window.setInterval(refresh, 5000)
    return () => {
      window.clearInterval(handle)
    }
  }, [active, refresh])

  const choices = React.useMemo(() => {
    void tick
    const workspaceSnapshot = workspaces?.list.getSnapshot()
    if (workspaceSnapshot === undefined) return []
    const sessions = sessionsList?.list.getSnapshot()
    return workspaceSnapshot.items.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sessions: workspace.sessionIds
        .map((id) => sessions?.byId[id])
        .filter((entry): entry is SessionSummary => entry !== undefined)
        // Running conversations first: they are the ones a user is likely to
        // want to steer something into.
        .sort((a, b) => Number(b.running === true) - Number(a.running === true) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    }))
  }, [workspaces, sessionsList, tick])

  return { choices, refresh }
}

/**
 * The right-click menu for a card.
 *
 * Dispatch goes through this menu rather than through drag-and-drop onto the
 * sidebar: the sidebar's session rows expose no stable identity to a third
 * party, so a drop target there could only be matched by rendered title. An
 * explicit menu also answers "where did it go" before the work starts.
 */
function CardMenu({
  issues,
  choices,
  x,
  y,
  onPick,
  onClose,
  onCopy,
}: {
  issues: readonly BoardIssue[]
  choices: readonly WorkspaceChoice[]
  x: number
  y: number
  onPick: (target: HandOverTarget, label: string) => void
  onClose: () => void
  onCopy: () => void
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState<string | undefined>(undefined)
  const ref = React.useRef<HTMLDivElement | null>(null)
  const subject = subjectOf(issues)

  // Any click outside, Escape, scroll, or resize dismisses: a menu that
  // outlives its context would act on a card that is no longer there.
  React.useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const itemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    color: C.text,
    padding: '6px 10px',
    fontSize: '0.84em',
    cursor: 'pointer',
    font: 'inherit',
  }

  const item = (key: string, label: string, hint: string, run: () => void): React.ReactElement =>
    LI(
      'button',
      { key, type: 'button', style: itemStyle, onClick: run },
      LI('span', { key: 'l', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      hint === '' ? null : LI('span', { key: 'h', style: { fontSize: '0.86em', color: C.textFaint } }, hint),
    )

  const separator = (key: string): React.ReactElement =>
    LI('div', { key, style: { height: 1, background: C.borderSoft, margin: '4px 0' } })

  // Keep the menu inside the viewport: open upward when there is no room below.
  const rows = 4 + choices.reduce((total, choice) => total + (choice.workspaceId === expanded ? choice.sessions.length + 1 : 1), 0)
  const estimated = 60 + rows * 29
  const flipY = typeof window !== 'undefined' && y + estimated > window.innerHeight
  const flipX = typeof window !== 'undefined' && x + 300 > window.innerWidth

  return LI(
    'div',
    {
      ref,
      role: 'menu',
      'data-dsh-jira-menu': '1',
      style: {
        position: 'fixed',
        left: flipX ? Math.max(8, x - 296) : x,
        top: flipY ? Math.max(8, y - estimated) : y,
        width: 296,
        maxHeight: '70vh',
        overflowY: 'auto',
        zIndex: 40,
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,.22)',
        padding: 5,
      },
    },
    LI(
      'div',
      { key: 'subject', style: { padding: '6px 10px 8px', fontSize: '0.78em', color: C.textFaint } },
      `${subject} 交给 agent`,
    ),

    item('new-here', '新建会话（当前工作区）', '', () => {
      onPick({ kind: 'new-session' }, '新建会话')
    }),
    item('current', '投到当前会话', '', () => {
      onPick({ kind: 'current-session' }, '当前会话')
    }),
    separator('sep-1'),
    LI(
      'div',
      { key: 'ws-title', style: { padding: '4px 10px', fontSize: '0.74em', color: C.textFaint } },
      choices.length === 0 ? '（没有可用工作区）' : '选择会话',
    ),

    ...choices.map((choice) => {
      const open = choice.workspaceId === expanded
      return LI(
        'div',
        { key: choice.workspaceId },
        LI(
          'button',
          {
            type: 'button',
            style: { ...itemStyle, fontWeight: open ? 600 : 400 },
            title: choice.path,
            onClick: () => {
              setExpanded(open ? undefined : choice.workspaceId)
            },
          },
          LI('span', { key: 'chevron', style: { width: 10, color: C.textFaint } }, open ? '▾' : '▸'),
          LI(
            'span',
            { key: 't', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            choice.title,
          ),
          LI('span', { key: 'n', style: { fontSize: '0.86em', color: C.textFaint } }, String(choice.sessions.length)),
        ),
        open
          ? LI(
              'div',
              { key: 'sessions', style: { paddingLeft: 12 } },
              item(`new-${choice.workspaceId}`, '＋ 新建会话', '', () => {
                onPick({ kind: 'new-session', workspaceId: choice.workspaceId }, `${choice.title} 的新会话`)
              }),
              ...choice.sessions.map((session) =>
                item(
                  session.id,
                  session.displayTitle,
                  session.running === true ? '进行中' : '',
                  () => {
                    onPick(
                      { kind: 'session', sessionId: session.id, label: session.displayTitle },
                      choice.title,
                    )
                  },
                ),
              ),
              choice.sessions.length === 0
                ? LI('div', { key: 'empty', style: { padding: '4px 10px', fontSize: '0.8em', color: C.textFaint } }, '这个工作区还没有会话')
                : null,
            )
          : null,
      )
    }),

    separator('sep-2'),
    item('copy', '复制提示词', '', onCopy),
  )
}

// ---------------------------------------------------------------------------
// Settings page → Atlassian
// ---------------------------------------------------------------------------

/** Poll the host's status; fast while authorization is in flight, slow after. */
function useStatus(): {
  payload: StatusPayload | undefined
  transportError: string | undefined
  refresh: () => Promise<void>
} {
  const [payload, setPayload] = React.useState<StatusPayload | undefined>(undefined)
  const [transportError, setTransportError] = React.useState<string | undefined>(undefined)
  const mounted = React.useRef(true)
  const sequence = React.useRef(0)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    const ticket = (sequence.current += 1)
    try {
      const next = await api<StatusPayload>('/status', 'GET')
      // Only the newest request may write state: a slow early response must not
      // overwrite a newer one.
      if (mounted.current && ticket === sequence.current) {
        setPayload(next)
        setTransportError(undefined)
      }
    } catch (error) {
      if (mounted.current && ticket === sequence.current) {
        setTransportError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const status = payload?.status ?? 'idle'
  const unsettled = status === 'connecting' || status === 'authorizing'

  React.useEffect(() => {
    const period = unsettled ? 1200 : 8000
    const handle = window.setInterval(() => {
      void refresh()
    }, period)
    return () => {
      window.clearInterval(handle)
    }
  }, [refresh, unsettled])

  return { payload, transportError, refresh }
}

/**
 * Replace the shell's generic settings gear on this plugin's Settings nav row.
 *
 * There is no supported way to do this. `settings.section` accepts only
 * `id`/`order`/`label` — no slot in the whole client contract has an `icon`
 * option — and the shell hardcodes the nav glyph by section id (`navIcon()` in
 * `dsh-client-ui-settings-general`), falling back to a generic gear for every
 * id it does not ship. So the row is found by its own label and the SVG swapped
 * in place.
 *
 * Written to fail safe: it matches only a `<button>` whose trimmed text is
 * exactly our label (the page's own heading is a `<div>`, so it cannot be
 * caught), it never throws, and if the shell changes its markup the only
 * outcome is that the gear stays.
 */
function patchNavGlyph(): void {
  for (const button of document.querySelectorAll('button')) {
    if ((button.textContent ?? '').trim() !== SECTION_LABEL) continue
    const current = button.querySelector('svg')
    if (current === null || current.hasAttribute(GLYPH_FLAG)) continue
    const replacement = navGlyph()
    // Adopt the shell's own class so sizing and colour stay the shell's business.
    const className = current.getAttribute('class')
    if (className !== null) replacement.setAttribute('class', className)
    current.replaceWith(replacement)
  }
}

function AtlassianSettings(): React.ReactElement {
  const { payload, transportError, refresh } = useStatus()
  const [busy, setBusy] = React.useState(false)
  const mounted = React.useRef(true)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Keep the nav row's glyph patched while this page is open. The observer is
  // scoped to this page's lifetime and coalesces bursts through a frame so the
  // periodic status re-render does not turn into a querySelectorAll storm.
  React.useEffect(() => {
    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        patchNavGlyph()
      })
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [])

  const act = React.useCallback(
    async (action: 'connect' | 'disconnect'): Promise<void> => {
      setBusy(true)
      try {
        await api(`/${action}`, 'POST')
      } catch (error) {
        console.error(`atlassian: ${action} failed`, error)
      } finally {
        if (mounted.current) setBusy(false)
        await refresh()
      }
    },
    [refresh],
  )

  const status = payload?.status ?? 'idle'
  const authorizationUrl = payload?.authorizationUrl
  const error = transportError ?? payload?.error

  return LI(
    'div',
    { style: { maxWidth: 640 } },
    LI(
      'div',
      { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
      LI(Mark, { key: 'mark' }),
      LI(
        'div',
        { key: 'titles', style: { minWidth: 0 } },
        LI('div', { key: 'name', style: { fontSize: '1.05em', fontWeight: 600, lineHeight: '1.35em' } }, 'Atlassian'),
        LI('div', { key: 'sub', style: { opacity: 0.65, fontSize: '0.85em' } }, '官方远程 MCP 服务器'),
      ),
    ),
    LI(
      'p',
      { key: 'intro', style: { opacity: 0.7, fontSize: '0.9em', marginTop: 0 } },
      '一次浏览器授权后，Jira、Confluence、Jira Service Management、Bitbucket 与 Compass 的工具会作为原生工具出现在 agent 的工具列表里，侧边栏也会多出一块 Jira 看板。',
    ),
    LI(
      'div',
      { key: 'state', style: box },
      // `Row` requires children, which the bare createElement overloads encode;
      // `ElementType` is the permissive form that accepts the props object.
      LI(Row as React.ElementType, { key: 'status', label: '状态' }, LI(Badge, { status })),
      payload?.site !== undefined
        ? LI(Row as React.ElementType, { key: 'site', label: '站点' }, payload.site)
        : null,
      LI(
        Row as React.ElementType,
        { key: 'tools', label: '可用工具' },
        payload === undefined ? '—' : String(payload.toolCount),
      ),
    ),
    payload?.siteMismatch === true
      ? LI(
          'div',
          { key: 'mismatch', style: { ...box, borderColor: TONE_COLOR['pending'] } },
          `授权的站点（${payload.site ?? '未知'}）与配置里预期的站点不一致。工具仍可使用，但它们指向的是上面这个站点。`,
        )
      : null,
    status === 'authorizing'
      ? LI(
          'div',
          { key: 'auth', style: box },
          LI(
            'div',
            { key: 'hint', style: { marginBottom: 8, fontSize: '0.9em' } },
            '点击下面的按钮会在浏览器中打开 Atlassian 授权页。若浏览器没有自动打开，也可以直接访问这个链接：',
          ),
          authorizationUrl === undefined
            ? LI('span', { key: 'wait', style: { opacity: 0.6, fontSize: '0.85em' } }, '正在获取授权链接…')
            : LI(
                'a',
                {
                  key: 'url',
                  href: authorizationUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { fontSize: '0.85em', wordBreak: 'break-all' },
                },
                authorizationUrl,
              ),
        )
      : null,
    error !== undefined
      ? LI(
          'div',
          { key: 'error', style: { ...box, borderColor: TONE_COLOR['bad'] } },
          LI('div', { key: 'title', style: { fontSize: '0.9em', color: TONE_COLOR['bad'], marginBottom: 4 } }, '失败'),
          LI('div', { key: 'body', style: { fontSize: '0.85em', opacity: 0.85, whiteSpace: 'pre-wrap' } }, error),
        )
      : null,
    LI(
      'div',
      { key: 'actions', style: { display: 'flex', gap: 10 } },
      LI(
        'button',
        {
          key: 'connect',
          type: 'button',
          style: { ...button, opacity: busy || status === 'ready' ? 0.5 : 1 },
          disabled: busy || status === 'ready',
          onClick: () => {
            void act('connect')
          },
        },
        status === 'authorizing' ? '打开授权页' : '连接 Atlassian',
      ),
      LI(
        'button',
        {
          key: 'disconnect',
          type: 'button',
          style: { ...button, opacity: busy || status === 'idle' ? 0.5 : 1 },
          disabled: busy || status === 'idle',
          onClick: () => {
            void act('disconnect')
          },
        },
        '断开连接',
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Board presentation helpers
// ---------------------------------------------------------------------------

/** Category buckets in board order, with a slot for an unknown bucket. */
const CATEGORY_ORDER = ['new', 'indeterminate', 'done', 'undefined'] as const

/**
 * Workflow-category accent, drawn from the shell's status tokens.
 *
 * Tokens are preferred over literals so the board follows the active theme in
 * both light and dark; the literals are the fallback for a shell that does not
 * define them.
 */
const CATEGORY_TONE: Record<string, string> = {
  new: tok('status-neutral', 'rgba(127,127,127,.9)'),
  indeterminate: tok('status-warning', '#c98a00'),
  done: tok('status-success', '#1a9e5c'),
  undefined: tok('status-neutral', 'rgba(127,127,127,.6)'),
}

const CATEGORY_LABEL: Record<string, string> = {
  new: '待办',
  indeterminate: '进行中',
  done: '完成',
  undefined: '未分类',
}

function categoryTone(key: string): string {
  return CATEGORY_TONE[key] ?? CATEGORY_TONE['undefined'] ?? 'rgba(127,127,127,.8)'
}

function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? ''
}

/** A per-project accent, so columns of cards separate at a glance. */
const PROJECT_PALETTE = ['#2f6fed', '#1a9e5c', '#a259d9', '#e2703a', '#0f8b8d', '#c94f7c', '#8a6d3b', '#5a6b8c']

function projectTone(key: string | undefined): string {
  if (key === undefined) return C.textDim
  let hash = 0
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  return PROJECT_PALETTE[hash % PROJECT_PALETTE.length] ?? C.accent
}

/**
 * Board queries: what the view selector actually changes.
 *
 * Two of Atlassian's own rules shape this. An unconstrained search is refused,
 * so every view is bounded. And a long backlog is not the same thing as work in
 * flight, so the default view excludes finished issues instead of burying the
 * active ones under them.
 *
 * Each view is a constant string, not a function, so two views that happen to
 * agree stay `===` and never retrigger a fetch.
 */
const VIEWS = [
  {
    id: 'active',
    label: '进行中',
    jql: 'updated >= -180d AND statusCategory != Done ORDER BY updated DESC',
  },
  {
    id: 'all',
    label: '全部',
    jql: 'updated >= -180d ORDER BY updated DESC',
  },
] as const

/** One filter choice, with the count that makes it worth clicking. */
interface Choice {
  value: string
  label: string
  count?: number | undefined
  tone?: string | undefined
}

/** Category buckets that are actually present, in board order, with counts. */
function categoryChoices(issues: readonly BoardIssue[]): Choice[] {
  const counts = new Map<string, number>()
  for (const issue of issues) counts.set(issue.status.categoryKey, (counts.get(issue.status.categoryKey) ?? 0) + 1)
  return CATEGORY_ORDER.filter((key) => (counts.get(key) ?? 0) > 0).map((key) => ({
    value: key,
    label: categoryLabel(key),
    count: counts.get(key) ?? 0,
    tone: categoryTone(key),
  }))
}

/** Jira's per-status colour hints, mapped onto something theme-safe. */
function statusAccent(status: BoardStatusInfo): string {
  return categoryTone(status.categoryKey)
}

/** Issue-type glyph, drawn inline so the panel ships no asset. */
function typeGlyph(type: string): React.ReactElement {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    style: { flex: 'none', opacity: 0.8 },
  } as const
  if (type.includes('故事')) return LI('svg', common, LI('circle', { cx: 8, cy: 8, r: 5.5 }))
  if (type.includes('缺陷')) {
    return LI(
      'svg',
      common,
      LI('circle', { key: 'b', cx: 8, cy: 9, r: 4 }),
      LI('path', { key: 'l', d: 'M8 5V2M4.5 6 2 4M11.5 6 14 4' }),
    )
  }
  if (type.includes('子任务')) return LI('svg', common, LI('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2 }))
  if (type.includes('长篇故事')) {
    return LI('svg', common, LI('path', { d: 'M2 13 6 4l3 6 2-3 3 6z' }))
  }
  return LI('svg', common, LI('path', { d: 'M3 8.5 6.5 12 13 4.5' }))
}

/** "3 分钟前" style relative time, falling back to the raw value. */
function relativeTime(value: string | undefined): string {
  if (value === undefined) return ''
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  const delta = Date.now() - time
  const minute = 60_000
  if (delta < minute) return '刚刚'
  if (delta < 60 * minute) return `${String(Math.floor(delta / minute))} 分钟前`
  if (delta < 24 * 60 * minute) return `${String(Math.floor(delta / (60 * minute)))} 小时前`
  if (delta < 30 * 24 * 60 * minute) return `${String(Math.floor(delta / (24 * 60 * minute)))} 天前`
  return new Date(time).toLocaleDateString()
}

/** Priority → a small coloured marker, or nothing when unset. */
function priorityTone(priority: string | undefined): string | undefined {
  if (priority === undefined) return undefined
  if (/highest|blocker|最高/i.test(priority)) return TONE_COLOR['bad']
  if (/high|高/i.test(priority)) return '#e2703a'
  if (/low|低/i.test(priority)) return TONE_COLOR['ok']
  return undefined
}

/** A small pill: a status, a priority, a project, a count. */
function Pill({
  children,
  tone,
  title,
  outline,
}: {
  children: React.ReactNode
  tone?: string | undefined
  title?: string | undefined
  outline?: boolean
}): React.ReactElement {
  const color = tone ?? C.textDim
  return LI(
    'span',
    {
      title,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        // `none`: a pill is content-sized. Without this it stretches to fill the
        // card footer, which pushes the timestamp out of the card entirely.
        flex: 'none',
        fontSize: '0.72em',
        lineHeight: '17px',
        padding: outline === true ? '0 8px' : '0',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: outline === true ? color : C.textDim,
        border: outline === true ? `1px solid ${color}` : 'none',
      },
    },
    outline === true
      ? LI('span', { key: 'dot', style: { width: 5, height: 5, borderRadius: 999, background: color, flex: 'none' } })
      : null,
    children,
  )
}

/** A selectable filter chip carrying its own count. */
function FilterChip({
  active,
  label,
  count,
  tone,
  title,
  onClick,
}: {
  active: boolean
  label: string
  count?: number | undefined
  tone?: string | undefined
  title?: string | undefined
  onClick: () => void
}): React.ReactElement {
  const color = tone ?? C.accent
  return LI(
    'button',
    {
      type: 'button',
      title,
      'aria-pressed': active,
      onClick,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        border: `1px solid ${active ? color : C.border}`,
        background: active ? C.accentSoft : 'transparent',
        color: active ? color : C.textDim,
        borderRadius: 999,
        padding: '3px 10px',
        fontSize: '0.8em',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
        font: 'inherit',
      },
    },
    label,
    count === undefined
      ? null
      : LI(
          'span',
          {
            key: 'count',
            style: {
              fontSize: '0.86em',
              minWidth: 15,
              textAlign: 'center',
              borderRadius: 999,
              padding: '0 4px',
              background: active ? 'transparent' : C.surfaceHover,
              opacity: active ? 0.85 : 0.7,
            },
          },
          String(count),
        ),
  )
}

/** One number in the header strip. */
function Stat({
  value,
  label,
  tone,
}: {
  value: number
  label: string
  tone?: string | undefined
}): React.ReactElement {
  return LI(
    'div',
    { style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
    LI('span', { key: 'v', style: { fontSize: '1.05em', fontWeight: 600, color: tone ?? C.text } }, String(value)),
    LI('span', { key: 'l', style: { fontSize: '0.74em', color: C.textFaint } }, label),
  )
}

/** One column: a status name and the issues currently in it. */
interface Column {
  id: string
  name: string
  categoryKey: string
  categoryName: string
  issues: BoardIssue[]
}

/**
 * Group issues into columns, ordered by Jira's status category.
 *
 * Category order (todo → doing → done) rather than alphabetical, because that
 * is the axis a board is read along. Within a category, columns sort by name,
 * which is stable across refreshes — a column that jumped position on every
 * poll would be unusable.
 */
function groupColumns(issues: readonly BoardIssue[]): Column[] {
  const byStatus = new Map<string, Column>()
  for (const issue of issues) {
    const name = issue.status.name
    let column = byStatus.get(name)
    if (column === undefined) {
      column = {
        id: name,
        name,
        categoryKey: issue.status.categoryKey,
        categoryName: issue.status.categoryName,
        issues: [],
      }
      byStatus.set(name, column)
    }
    column.issues.push(issue)
  }
  const rank = (key: string): number => {
    const index = CATEGORY_ORDER.indexOf(key as (typeof CATEGORY_ORDER)[number])
    return index < 0 ? CATEGORY_ORDER.length : index
  }
  const columns = [...byStatus.values()]
  columns.sort((a, b) => {
    const order = rank(a.categoryKey) - rank(b.categoryKey)
    return order !== 0 ? order : a.name.localeCompare(b.name)
  })
  return columns
}

// ---------------------------------------------------------------------------
// Markdown (descriptions are user-authored; nothing is trusted as HTML)
// ---------------------------------------------------------------------------

/** Inline Markdown: links, bold, inline code. Everything else stays literal. */
function inlineNodes(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const pattern = /(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(\*\*[^*]+\*\*)|(`[^`]+`)/g
  let cursor = 0
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${String(index++)}`
    if (match[2] !== undefined) {
      const href = match[2]
      out.push(
        LI(
          'a',
          { key, href, target: '_blank', rel: 'noreferrer', style: { color: C.accent, wordBreak: 'break-all' } },
          (match[1] ?? href).replace(/^\[/, '').replace(/\]\(.*\)$/, ''),
        ),
      )
    } else if (token.startsWith('**')) {
      out.push(LI('strong', { key, style: { fontWeight: 600 } }, token.slice(2, -2)))
    } else {
      out.push(
        LI(
          'code',
          {
            key,
            style: {
              background: C.surfaceHover,
              borderRadius: 4,
              padding: '1px 4px',
              fontSize: '0.9em',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
          },
          token.slice(1, -1),
        ),
      )
    }
    cursor = match.index + token.length
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/**
 * A small Markdown renderer for an issue description.
 *
 * The MCP server renders `description` as Markdown and the panel must not inject
 * HTML. So this handles the constructs these descriptions actually use —
 * headings, bullets, bold, inline code, links, rules — and emits React nodes,
 * which escape everything by construction. Anything unrecognized stays literal
 * text, which is the safe default.
 */
function markdownNodes(source: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let bullets: string[] = []
  let counter = 0

  const flush = (): void => {
    if (bullets.length === 0) return
    const items = bullets
    bullets = []
    const key = `${keyPrefix}-ul-${String(counter++)}`
    out.push(
      LI(
        'ul',
        { key, style: { margin: '4px 0 8px', paddingLeft: 20 } },
        items.map((item, index) =>
          LI('li', { key: index, style: { marginBottom: 3 } }, ...inlineNodes(item, `${key}-${String(index)}`)),
        ),
      ),
    )
  }

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^\s*[-*+]\s+/.test(line)) {
      bullets.push(line.replace(/^\s*[-*+]\s+/, ''))
      continue
    }
    flush()
    if (line.trim() === '') continue
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push(
        LI('hr', {
          key: `${keyPrefix}-hr-${String(counter++)}`,
          style: { border: 0, borderTop: `1px solid ${C.borderSoft}`, margin: '10px 0' },
        }),
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = (heading[1] ?? '').length
      const text = heading[2] ?? ''
      const key = `${keyPrefix}-h-${String(counter++)}`
      out.push(
        LI(
          `h${String(Math.min(level + 2, 6))}`,
          {
            key,
            style: { fontSize: level <= 2 ? '1em' : '0.94em', fontWeight: 600, margin: '12px 0 4px', lineHeight: 1.4 },
          },
          ...inlineNodes(text, key),
        ),
      )
      continue
    }
    const key = `${keyPrefix}-p-${String(counter++)}`
    out.push(
      LI('p', { key, style: { margin: '0 0 8px', lineHeight: 1.55 } }, ...inlineNodes(line, key)),
    )
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------
// Board components
// ---------------------------------------------------------------------------

/** One issue card. Draggable, because the drag is the hand-over gesture. */
function IssueCard({
  issue,
  selected,
  checked,
  multi,
  dragging,
  onSelect,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  issue: BoardIssue
  selected: boolean
  /** Part of the multi-selection, which is a different thing from "open". */
  checked: boolean
  /** Whether a multi-selection exists at all (changes what a plain click does). */
  multi: boolean
  dragging: boolean
  onSelect: (event: React.MouseEvent) => void
  onToggle: () => void
  onContextMenu: (event: React.MouseEvent) => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}): React.ReactElement {
  const priority = priorityTone(issue.priority)
  const accent = categoryTone(issue.status.categoryKey)
  const project = projectTone(issue.projectKey)
  return LI(
    'div',
    {
      'data-dsh-jira-card': '1',
      'data-key': issue.key,
      'data-project': issue.projectKey ?? '',
      'data-category': issue.status.categoryKey,
      'data-checked': checked ? '1' : '0',
      'data-dragging': dragging ? '1' : '0',
      draggable: true,
      onDragStart,
      onDragEnd,
      onClick: onSelect,
      onContextMenu,
      role: 'button',
      tabIndex: 0,
      'aria-pressed': checked,
      title: `${issue.key} · ${issue.status.name}${issue.projectName === undefined ? '' : ` · ${issue.projectName}`}`,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onToggle()
        }
        if (event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      },
      style: {
        position: 'relative',
        // `none`: a card is content-sized. As a flex item in a column whose
        // height is bounded, the default `flex-shrink: 1` squashes cards below
        // their content and the footer then spills past the card's border.
        flex: 'none',
        border: `1px solid ${checked ? C.accent : selected ? C.accent : C.borderSoft}`,
        background: checked ? C.accentSoft : selected ? C.surfaceHover : C.surfaceSoft,
        borderRadius: 9,
        padding: '9px 11px 8px 14px',
        cursor: 'grab',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        overflow: 'hidden',
        ...(multi
          ? { boxShadow: checked ? `inset 0 0 0 1px ${C.accent}` : 'none' }
          : {}),
      },
    },
    // The status colour as a spine: it is the one attribute a reader scans for,
    // and a stripe cannot be confused with the priority marker inside the card.
    LI('span', {
      key: 'spine',
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 3,
        background: accent,
      },
    }),
    // The checkbox appears only once a selection exists, and is a hit target of
    // its own: turning every card into a checkbox before the user asks for one
    // makes a plain click ambiguous.
    multi
      ? LI(
          'span',
          {
            key: 'check',
            onClick: (event: React.MouseEvent) => {
              event.stopPropagation()
              onToggle()
            },
            title: checked ? '取消选择' : '加入选择',
            style: {
              position: 'absolute',
              top: 7,
              right: 8,
              width: 15,
              height: 15,
              borderRadius: 4,
              border: `1px solid ${checked ? C.accent : C.border}`,
              background: checked ? C.accent : C.surface,
              color: '#fff',
              fontSize: '0.7em',
              lineHeight: '13px',
              textAlign: 'center',
              cursor: 'pointer',
            },
          },
          checked ? '✓' : '',
        )
      : null,
    LI(
      'div',
      { key: 'meta', style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingRight: multi ? 18 : 0 } },
      LI('span', { key: 'glyph', style: { display: 'inline-flex', color: C.textFaint } }, typeGlyph(issue.type)),
      LI(
        'span',
        {
          key: 'key',
          style: {
            fontSize: '0.76em',
            fontWeight: 700,
            color: C.textDim,
            letterSpacing: '.02em',
            textDecoration: 'none',
          },
        },
        issue.key,
      ),
      priority !== undefined
        ? LI('span', {
            key: 'prio',
            title: `优先级 ${issue.priority ?? ''}`,
            style: { width: 6, height: 6, borderRadius: 999, background: priority, display: 'inline-block', flex: 'none' },
          })
        : null,
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      issue.assignee !== undefined
        ? LI(
            'span',
            {
              key: 'who',
              title: `负责人 ${issue.assignee}`,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                flex: 'none',
                borderRadius: 999,
                background: C.surfaceHover,
                fontSize: '0.62em',
                color: C.textDim,
                fontWeight: 600,
              },
            },
            // Initials, not the full name: at 18px a name is unreadable and
            // pushes the width around; the full name stays in `title`.
            [...issue.assignee].slice(0, 1).join(''),
          )
        : null,
    ),
    // The clamp lives on an INNER block: `-webkit-line-clamp` needs
    // `display: -webkit-box`, and a flex item that is also a `-webkit-box` gets
    // its height computed as 0 by Chromium — the text then renders clipped and
    // the footer overlaps it. A plain block wrapper keeps both behaviours.
    LI(
      'div',
      { key: 'summary-wrap', style: { minWidth: 0 } },
      LI(
        'div',
        {
          style: {
            fontSize: '0.88em',
            lineHeight: 1.45,
            wordBreak: 'break-word',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          },
        },
        issue.summary,
      ),
    ),
    LI(
      'div',
      {
        key: 'foot',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: '0.72em',
          color: C.textFaint,
          borderTop: `1px solid ${C.borderSoft}`,
          paddingTop: 6,
        },
      },
      issue.projectKey !== undefined
        ? LI(Pill as React.ElementType, { key: 'project', tone: project, outline: true }, issue.projectKey)
        : null,
      issue.status.categoryKey === 'done'
        ? LI(Pill as React.ElementType, { key: 'state', tone: accent }, '已完成')
        : null,
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      LI('span', { key: 'time', title: issue.updated ?? '' }, relativeTime(issue.updated)),
    ),
  )
}

/** The right-hand drawer: one issue in full, plus every action on it. */
function IssueDrawer({
  issue,
  promptTemplate,
  onClose,
  onRefreshBoard,
  onNotify,
}: {
  issue: BoardIssue
  promptTemplate: string
  onClose: () => void
  onRefreshBoard: () => void
  onNotify: (message: string, tone: 'ok' | 'bad') => void
}): React.ReactElement {
  const services = useHandover()
  const [detail, setDetail] = React.useState<DetailPayload | undefined>(undefined)
  const [transitions, setTransitions] = React.useState<BoardTransition[] | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let live = true
    setLoading(true)
    setError(undefined)
    setDetail(undefined)
    setTransitions(undefined)
    const key = encodeURIComponent(issue.key)
    // The drawer opens on data the board already has, so both requests run
    // together: a slow description must not hold back the transition menu.
    Promise.all([
      api<DetailPayload>(`/issue/${key}`, 'GET'),
      api<TransitionsPayload>(`/issue/${key}/transitions`, 'GET').catch(
        (reason: unknown): TransitionsPayload => ({
          ok: false,
          transitions: [],
          ...(reason instanceof Error ? { error: reason.message } : {}),
        }),
      ),
    ])
      .then(([nextDetail, nextTransitions]) => {
        if (!live) return
        setDetail(nextDetail)
        setTransitions(nextTransitions.transitions)
        if (!nextTransitions.ok) setError(nextTransitions.error ?? '读取可用流转失败')
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [issue.key])

  const runTransition = React.useCallback(
    async (transition: BoardTransition): Promise<void> => {
      setBusy(true)
      try {
        await api('/transition', 'POST', { key: issue.key, transitionId: transition.id })
        onNotify(`${issue.key} → ${transition.toName}`, 'ok')
        onRefreshBoard()
      } catch (reason) {
        onNotify(reason instanceof Error ? reason.message : String(reason), 'bad')
      } finally {
        setBusy(false)
      }
    },
    [issue.key, onNotify, onRefreshBoard],
  )

  const dispatch = React.useCallback(
    async (target: HandOverTarget): Promise<void> => {
      setBusy(true)
      try {
        const result = await handOver(services, [issue], promptTemplate, target)
        onNotify(result.message, result.ok ? 'ok' : 'bad')
      } finally {
        setBusy(false)
      }
    },
    [services, issue, promptTemplate, onNotify],
  )

  const copyPrompt = React.useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildPrompt([issue], promptTemplate))
      setCopied(true)
      window.setTimeout(() => {
        setCopied(false)
      }, 1600)
    } catch {
      onNotify('复制失败 —— 浏览器拒绝了剪贴板访问', 'bad')
    }
  }, [issue, promptTemplate, onNotify])

  const shown = detail?.issue ?? issue
  const description = detail?.description ?? ''
  const metaChips: React.ReactNode[] = []
  if (shown.priority !== undefined) metaChips.push(LI('span', { key: 'p', style: { ...chip, cursor: 'default' } }, `优先级 ${shown.priority}`))
  if (shown.assignee !== undefined) metaChips.push(LI('span', { key: 'a', style: { ...chip, cursor: 'default' } }, shown.assignee))
  if (shown.projectKey !== undefined) {
    metaChips.push(LI('span', { key: 'j', style: { ...chip, cursor: 'default' } }, shown.projectName ?? shown.projectKey))
  }
  if (shown.updated !== undefined) {
    metaChips.push(LI('span', { key: 'u', style: { ...chip, cursor: 'default' } }, `更新于 ${relativeTime(shown.updated)}`))
  }

  return LI(
    'div',
    {
      style: {
        width: 384,
        flex: 'none',
        borderLeft: `1px solid ${C.border}`,
        paddingLeft: 16,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
    },
    // Sticky, because the actions are why the drawer is open: scrolling a long
    // description must not scroll the buttons out of reach.
    LI(
      'div',
      {
        key: 'head',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: C.surface,
          paddingTop: 2,
          paddingBottom: 8,
          borderBottom: `1px solid ${C.borderSoft}`,
        },
      },
      LI('span', { key: 'glyph', style: { display: 'inline-flex', color: C.textFaint } }, typeGlyph(shown.type)),
      LI('span', { key: 'key', style: { fontWeight: 700, fontSize: '0.9em' } }, shown.key),
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      shown.url !== undefined
        ? LI(
            'a',
            {
              key: 'open',
              href: shown.url,
              target: '_blank',
              rel: 'noreferrer',
              style: { ...chip, textDecoration: 'none' },
            },
            '在 Jira 打开',
          )
        : null,
      LI('button', { key: 'close', type: 'button', style: chip, onClick: onClose }, '关闭'),
    ),
    LI('div', { key: 'summary', style: { fontSize: '0.95em', fontWeight: 600, lineHeight: 1.45 } }, shown.summary),
    LI(
      'div',
      { key: 'meta', style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: '0.76em' } },
      LI(
        'span',
        {
          key: 'status',
          style: {
            border: `1px solid ${statusAccent(shown.status)}`,
            color: statusAccent(shown.status),
            borderRadius: 999,
            padding: '1px 9px',
          },
        },
        shown.status.name,
      ),
      ...metaChips,
    ),

    // Hand-over and workflow writes are separate gestures on purpose: dispatch
    // starts unattended work, the transition menu is the only Jira writer.
    LI(
      'div',
      {
        key: 'actions',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          paddingBottom: 10,
          borderBottom: `1px solid ${C.borderSoft}`,
        },
      },
      LI(
        'button',
        {
          key: 'new',
          type: 'button',
          style: { ...chip, borderColor: C.accent, color: C.accent, opacity: busy ? 0.5 : 1 },
          disabled: busy,
          onClick: () => {
            void dispatch({ kind: 'new-session' })
          },
        },
        '交给 agent（新会话）',
      ),
      LI(
        'button',
        {
          key: 'current',
          type: 'button',
          style: { ...chip, opacity: busy ? 0.5 : 1 },
          disabled: busy,
          onClick: () => {
            void dispatch({ kind: 'current-session' })
          },
        },
        '投到当前会话',
      ),
      LI('button', { key: 'copy', type: 'button', style: chip, onClick: () => void copyPrompt() }, copied ? '已复制' : '复制提示词'),
    ),

    // Transitions: exactly the set the server offers right now, never a guess.
    LI(
      'div',
      { key: 'transitions' },
      LI('div', { key: 'title', style: { fontSize: '0.76em', color: C.textFaint, marginBottom: 6 } }, '变更状态'),
      transitions === undefined
        ? LI('div', { key: 'loading', style: { fontSize: '0.8em', color: C.textFaint } }, '读取中…')
        : transitions.length === 0
          ? LI('div', { key: 'none', style: { fontSize: '0.8em', color: C.textFaint } }, '当前没有可用的流转')
          : LI(
              'div',
              { key: 'list', style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              transitions.map((transition) =>
                LI(
                  'button',
                  {
                    key: transition.id,
                    type: 'button',
                    style: {
                      ...chip,
                      opacity: busy ? 0.5 : 1,
                      ...(transition.toCategoryKey === 'done' ? { color: TONE_COLOR['ok'] } : {}),
                    },
                    disabled: busy,
                    title: `流转 id ${transition.id}`,
                    onClick: () => {
                      void runTransition(transition)
                    },
                  },
                  transition.toName,
                ),
              ),
            ),
    ),

    error !== undefined
      ? LI(
          'div',
          { key: 'error', style: { fontSize: '0.8em', color: TONE_COLOR['bad'], whiteSpace: 'pre-wrap' } },
          error,
        )
      : null,

    LI(
      'div',
      { key: 'body', style: { fontSize: '0.87em', minWidth: 0, paddingBottom: 16 } },
      LI('div', { key: 'label', style: { fontSize: '0.78em', color: C.textFaint, marginBottom: 6 } }, '描述'),
      loading && description === ''
        ? LI('div', { key: 'loading', style: { fontSize: '0.85em', color: C.textFaint } }, '读取中…')
        : description === ''
          ? LI('div', { key: 'empty', style: { fontSize: '0.85em', color: C.textFaint } }, '（无描述）')
          : LI('div', { key: 'md', 'data-dsh-jira-md': '1' }, ...markdownNodes(description, shown.key)),
    ),
  )
}

/**
 * The board panel: the keyed `main` cell addressed by the sidebar icon.
 *
 * Filtering is CLIENT-side on purpose. The server's answer is bounded (the
 * configured page size), and refining what is already in hand is instant, works
 * with a query the user typed by hand, and costs no round-trips. Only the
 * bounded JQL view itself goes to the server.
 */
function JiraBoardPanel(): React.ReactElement {
  const services = useHandover()
  const { payload: status } = useStatus()
  const promptTemplate = status?.board.promptTemplate ?? ''
  const configJql = status?.board.jql ?? ''

  const [board, setBoard] = React.useState<BoardPayload | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [override, setOverride] = React.useState<string | undefined>(undefined)
  /** What the JQL box shows while it is being edited. */
  const [jqlDraft, setJqlDraft] = React.useState('')
  const [editingJql, setEditingJql] = React.useState(false)
  const [viewId, setViewId] = React.useState<string>(VIEWS[0].id)
  const [project, setProject] = React.useState('all')
  const [category, setCategory] = React.useState('all')
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<string | undefined>(undefined)
  /** Multi-selection, by issue key. Empty means "no selection mode". */
  const [checked, setChecked] = React.useState<readonly string[]>([])
  /** Where the multi-selection was last anchored, for shift-click ranges. */
  const anchor = React.useRef<string | undefined>(undefined)
  const [menu, setMenu] = React.useState<{ x: number; y: number; keys: readonly string[] } | undefined>(undefined)
  const [dragging, setDragging] = React.useState<string | undefined>(undefined)
  const [notice, setNotice] = React.useState<{ message: string; tone: 'ok' | 'bad' } | undefined>(undefined)
  const [updatedAt, setUpdatedAt] = React.useState<number | undefined>(undefined)
  const mounted = React.useRef(true)
  const sequence = React.useRef(0)
  /** The configured JQL has been installed once, and only once. */
  const seeded = React.useRef(false)
  // Re-read the workspace/session lists while a menu is open, so a session that
  // finishes underneath it does not get labelled as running.
  const { choices } = useWorkspaceChoices(menu !== undefined)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A deployment that pins `board.jql` opens on exactly that query, and the
  // view selector starts on "全部" so its highlight does not claim a view whose
  // query is not the one in force. Otherwise the bounded "work in flight" view
  // is the default, because a long backlog buries the issues anyone reads.
  React.useEffect(() => {
    if (seeded.current || status === undefined) return
    seeded.current = true
    if (configJql.trim() !== '') {
      setOverride(configJql)
      setViewId('all')
    }
  }, [status, configJql])

  const activeView = VIEWS.find((view) => view.id === viewId) ?? VIEWS[0]
  const effectiveJql = override ?? activeView.jql

  React.useEffect(() => {
    if (!editingJql) setJqlDraft(effectiveJql)
  }, [effectiveJql, editingJql])

  const refresh = React.useCallback(async (): Promise<void> => {
    const ticket = (sequence.current += 1)
    setLoading(true)
    try {
      const suffix = effectiveJql.trim() === '' ? '' : `?jql=${encodeURIComponent(effectiveJql)}`
      const next = await api<BoardPayload>(`/board${suffix}`, 'GET')
      // Only the newest request may write state: a slow early response must not
      // overwrite a newer one.
      if (mounted.current && ticket === sequence.current) {
        setBoard(next)
        setError(undefined)
        setUpdatedAt(Date.now())
      }
    } catch (reason) {
      if (mounted.current && ticket === sequence.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (mounted.current && ticket === sequence.current) setLoading(false)
    }
  }, [effectiveJql])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // A slow poll, skipped while the page is hidden. The board mirrors a remote
  // system, so an interval is the whole sync story — there is no push channel.
  React.useEffect(() => {
    const handle = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60_000)
    return () => {
      window.clearInterval(handle)
    }
  }, [refresh])

  const notify = React.useCallback((message: string, tone: 'ok' | 'bad'): void => {
    setNotice({ message, tone })
    window.setTimeout(() => {
      setNotice((current) => (current?.message === message ? undefined : current))
    }, 6000)
  }, [])

  /**
   * Read the issue keys out of a drag payload.
   *
   * The payload is a JSON array so a drag can carry a multi-selection. A bare
   * key is still accepted: an older payload, or one from a browser that refused
   * to store custom types, must not become a crash.
   */
  const keysFromDrag = (dataTransfer: DataTransfer | null): readonly string[] => {
    if (dataTransfer === null) return []
    const raw = dataTransfer.getData(DRAG_MIME)
    if (raw === '') return []
    if (raw.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string')
      } catch {
        // Fall through to treating it as a single key.
      }
    }
    return [raw]
  }

  /**
   * Accept a drop arriving from the sidebar path.
   *
   * A drag that started on a card can outlive this component, because the panel
   * unmounts when another panel is selected. When the drop lands here the board
   * selects what was dragged and opens the menu, so the destination is still an
   * explicit choice rather than a guess about which sidebar row was under the
   * cursor.
   */
  React.useEffect(() => {
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<{ keys?: readonly string[] }>).detail
      const keys = detail?.keys
      if (keys === undefined || keys.length === 0) return
      setChecked(keys)
      if (keys.length === 1 && keys[0] !== undefined) setSelected(keys[0])
    }
    const onDrop = (event: DragEvent): void => {
      if (event.dataTransfer === null || !event.dataTransfer.types.includes(DRAG_MIME)) return
      const keys = keysFromDrag(event.dataTransfer)
      if (keys.length === 0) return
      event.preventDefault()
      setChecked(keys)
      setMenu({ x: event.clientX, y: event.clientY, keys })
    }
    window.addEventListener('dsh-jira-focus', onFocus)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dsh-jira-focus', onFocus)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const issues = React.useMemo(() => board?.issues ?? [], [board])

  /**
   * The projects present in the current view.
   *
   * Derived from what was actually loaded rather than from the project list:
   * offering a project that this query returns nothing for is a dead end, and
   * the counts make the choice self-explanatory.
   */
  const projects = React.useMemo(() => {
    const seen = new Map<string, { key: string; name: string; count: number }>()
    for (const issue of issues) {
      const key = issue.projectKey
      if (key === undefined) continue
      const entry = seen.get(key)
      if (entry === undefined) seen.set(key, { key, name: issue.projectName ?? key, count: 1 })
      else entry.count += 1
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  }, [issues])

  const categories = React.useMemo(() => categoryChoices(issues), [issues])

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return issues.filter((issue) => {
      if (project !== 'all' && issue.projectKey !== project) return false
      if (category !== 'all' && issue.status.categoryKey !== category) return false
      if (needle !== '') {
        const haystack = `${issue.key} ${issue.summary} ${issue.projectName ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [issues, project, category, query])

  const columns = React.useMemo(() => groupColumns(visible), [visible])
  const selectedIssue = issues.find((issue) => issue.key === selected)
  const checkedIssues = React.useMemo(
    () => visible.filter((issue) => checked.includes(issue.key)),
    [visible, checked],
  )
  const connected = status?.status === 'ready'
  const filtering = project !== 'all' || category !== 'all' || query.trim() !== ''

  const toggleChecked = React.useCallback((key: string): void => {
    anchor.current = key
    setChecked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }, [])

  /**
   * A plain click opens the drawer, and only starts a selection once one exists.
   *
   * Shift-click extends from the previous anchor over the order the reader sees
   * (left to right, top to bottom), which is the order the columns are in.
   */
  const selectIssue = React.useCallback(
    (issue: BoardIssue, event: React.MouseEvent): void => {
      if (event.shiftKey) {
        const order = columns.flatMap((column) => column.issues.map((entry) => entry.key))
        const anchorKey = anchor.current
        const to = order.indexOf(issue.key)
        const from = anchorKey === undefined ? -1 : order.indexOf(anchorKey)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          setChecked((current) => [...new Set([...current, ...order.slice(start, end + 1)])])
          return
        }
      }
      if (checked.length > 0) {
        toggleChecked(issue.key)
        return
      }
      anchor.current = issue.key
      setSelected(issue.key === selected ? undefined : issue.key)
    },
    [columns, checked.length, selected, toggleChecked],
  )

  const openMenu = React.useCallback(
    (issue: BoardIssue, event: React.MouseEvent): void => {
      event.preventDefault()
      // Right-clicking a card that is not part of the selection acts on that
      // card alone; right-clicking inside one acts on the whole selection.
      const keys = checked.includes(issue.key) ? checked : [issue.key]
      if (!checked.includes(issue.key)) {
        setChecked([issue.key])
        anchor.current = issue.key
      }
      setMenu({ x: event.clientX, y: event.clientY, keys })
    },
    [checked],
  )

  /** Hand the given keys over and report the outcome. */
  const dispatch = React.useCallback(
    async (keys: readonly string[], target: HandOverTarget): Promise<void> => {
      const chosen = visible.filter((issue) => keys.includes(issue.key))
      setMenu(undefined)
      const result = await handOver(services, chosen, promptTemplate, target)
      notify(result.message, result.ok ? 'ok' : 'bad')
      if (result.ok) setChecked([])
    },
    [visible, promptTemplate, notify],
  )

  const copyPrompt = React.useCallback(
    async (keys: readonly string[]): Promise<void> => {
      const chosen = visible.filter((issue) => keys.includes(issue.key))
      setMenu(undefined)
      try {
        await navigator.clipboard.writeText(buildPrompt(chosen, promptTemplate))
        notify(`已复制 ${subjectOf(chosen)} 的提示词`, 'ok')
      } catch {
        notify('复制失败 —— 浏览器拒绝了剪贴板访问', 'bad')
      }
    },
    [visible, promptTemplate, notify],
  )

  const onDragStart = React.useCallback((issue: BoardIssue, event: React.DragEvent) => {
    setDragging(issue.key)
    try {
      // Dragging one of a selection drags the whole selection: that is what the
      // visible highlight promises, and a single-card payload would contradict it.
      const keys = checked.includes(issue.key) ? checked : [issue.key]
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(keys))
      event.dataTransfer.setData('text/plain', keys.join(', '))
      event.dataTransfer.effectAllowed = 'copy'
    } catch {
      // Some browsers refuse custom MIME types; the drag still selects.
    }
  }, [checked])

  const body: React.ReactNode = (() => {
    if (!connected && board === undefined) {
      return LI(
        'div',
        { key: 'offline', style: { ...box, margin: 0, maxWidth: 460 } },
        '还没有连接到 Atlassian。到 设置 → Atlassian 点「连接 Atlassian」，授权后这块看板会自动出现内容。',
      )
    }
    if (error !== undefined) {
      return LI(
        'div',
        { key: 'error', style: { ...box, margin: 0, maxWidth: 560, borderColor: TONE_COLOR['bad'] } },
        LI('div', { key: 'title', style: { color: TONE_COLOR['bad'], fontSize: '0.9em', marginBottom: 6 } }, '读取失败'),
        LI('div', { key: 'body', style: { fontSize: '0.85em', whiteSpace: 'pre-wrap', opacity: 0.9 } }, error),
      )
    }
    if (columns.length === 0) {
      return LI(
        'div',
        { key: 'empty', style: { ...box, margin: 0, maxWidth: 560 } },
        loading
          ? '读取中…'
          : filtering
            ? '当前筛选下没有工单。放宽项目或状态，或清空搜索框。'
            : '这个查询没有返回工单。换一个视图，或在 JQL 里放宽时间范围。',
      )
    }
    return columns.map((column) =>
      LI(
        'div',
        {
          key: column.id,
          style: { width: 276, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8 },
        },
        LI(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 2 } },
          LI('span', {
            key: 'dot',
            style: {
              width: 7,
              height: 7,
              borderRadius: 999,
              background: categoryTone(column.categoryKey),
              display: 'inline-block',
              flex: 'none',
            },
          }),
          LI('span', { key: 'name', style: { fontSize: '0.83em', fontWeight: 600 } }, column.name),
          LI(
            'span',
            {
              key: 'count',
              style: {
                fontSize: '0.72em',
                color: C.textFaint,
                background: C.surfaceHover,
                borderRadius: 999,
                padding: '0 6px',
                lineHeight: '16px',
              },
            },
            String(column.issues.length),
          ),
          LI('span', { key: 'spacer', style: { flex: 1 } }),
          // Only when it adds something: `待办` is the name of both the status
          // and its category, and printing it twice reads as a mistake.
          column.categoryName === column.name
            ? null
            : LI('span', { key: 'category', style: { fontSize: '0.7em', color: C.textFaint } }, column.categoryName),
        ),
        LI(
          'div',
          {
            key: 'cards',
            style: { display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingRight: 2, paddingBottom: 4 },
          },
          column.issues.map((issue) =>
            LI(IssueCard, {
              key: issue.key,
              issue,
              selected: issue.key === selected,
              checked: checked.includes(issue.key),
              multi: checked.length > 0,
              dragging: issue.key === dragging,
              onSelect: (event: React.MouseEvent) => {
                selectIssue(issue, event)
              },
              onToggle: () => {
                toggleChecked(issue.key)
              },
              onContextMenu: (event: React.MouseEvent) => {
                openMenu(issue, event)
              },
              onDragStart: (event: React.DragEvent) => {
                onDragStart(issue, event)
              },
              onDragEnd: () => {
                setDragging(undefined)
              },
            }),
          ),
        ),
      ),
    )
  })()

  return LI(
    'div',
    {
      'data-dsh-jira-board': '1',
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '16px 18px 0', gap: 10 },
    },

    // Header: identity, then the numbers that say what is on the board.
    LI(
      'div',
      { key: 'header', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
      LI(Mark, { key: 'mark' }),
      LI(
        'div',
        { key: 'titles', style: { minWidth: 0 } },
        LI('div', { key: 'name', style: { fontSize: '1.05em', fontWeight: 600 } }, 'Jira 看板'),
        LI(
          'div',
          { key: 'sub', style: { fontSize: '0.78em', color: C.textFaint } },
          board?.site ?? status?.site ?? 'Atlassian',
          updatedAt === undefined ? '' : ` · 更新于 ${new Date(updatedAt).toLocaleTimeString()}`,
        ),
      ),
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      LI(
        'div',
        { key: 'stats', style: { display: 'flex', alignItems: 'baseline', gap: 16 } },
        LI(Stat, { key: 'total', value: visible.length, label: filtering ? `/ ${String(issues.length)} 个工单` : '个工单' }),
        ...categoryChoices(visible).map((choice) =>
          LI(Stat, { key: choice.value, value: choice.count ?? 0, label: choice.label, tone: choice.tone }),
        ),
      ),
      LI(Badge, { key: 'badge', status: status?.status ?? 'idle' }),
    ),

    // Toolbar. Projects lead because that is the axis a multi-project site is
    // read along; the status filter follows the same shape so the two rows scan
    // the same way. Each chip carries its own count.
    LI(
      'div',
      { key: 'filters', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      LI(
        'div',
        { key: 'projects', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30 } }, '项目'),
        projects.length > 0
          ? LI(FilterChip, {
              key: 'all',
              active: project === 'all',
              label: '全部',
              count: issues.length,
              onClick: () => {
                setProject('all')
              },
            })
          : null,
        projects.map((entry) =>
          LI(FilterChip, {
            key: entry.key,
            active: project === entry.key,
            label: entry.key,
            count: entry.count,
            tone: projectTone(entry.key),
            title: entry.name,
            onClick: () => {
              setProject(project === entry.key ? 'all' : entry.key)
            },
          }),
        ),
      ),
      LI(
        'div',
        { key: 'states', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30 } }, '状态'),
        LI(FilterChip, {
          key: 'all',
          active: category === 'all',
          label: '全部',
          onClick: () => {
            setCategory('all')
          },
        }),
        categories.map((choice) =>
          LI(FilterChip, {
            key: choice.value,
            active: category === choice.value,
            label: choice.label,
            count: choice.count,
            tone: choice.tone,
            onClick: () => {
              setCategory(category === choice.value ? 'all' : choice.value)
            },
          }),
        ),
      ),
    ),

    // View, search, and the JQL box. The JQL is shown rather than hidden behind
    // a toggle: it is the board's real state, and hiding it made an unexpected
    // set of issues look like a bug.
    LI(
      'div',
      { key: 'controls', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      LI(
        'div',
        {
          key: 'views',
          style: { display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' },
        },
        VIEWS.map((view, index) =>
          LI(
            'button',
            {
              key: view.id,
              type: 'button',
              'aria-pressed': override === undefined && view.id === activeView.id,
              title: view.jql,
              onClick: () => {
                setOverride(undefined)
                setViewId(view.id)
              },
              style: {
                border: 'none',
                borderLeft: index === 0 ? 'none' : `1px solid ${C.border}`,
                background: override === undefined && view.id === activeView.id ? C.accentSoft : 'transparent',
                color: override === undefined && view.id === activeView.id ? C.accent : C.textDim,
                padding: '5px 12px',
                fontSize: '0.82em',
                fontWeight: override === undefined && view.id === activeView.id ? 600 : 400,
                cursor: 'pointer',
                font: 'inherit',
              },
            },
            view.label,
          ),
        ),
      ),
      LI('input', {
        key: 'search',
        value: query,
        placeholder: '搜索编号或标题…',
        spellCheck: false,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          setQuery(event.target.value)
        },
        style: { ...input, flex: '1 1 180px', maxWidth: 280 },
      }),
      filtering
        ? LI(
            'button',
            {
              key: 'clear',
              type: 'button',
              style: chip,
              onClick: () => {
                setProject('all')
                setCategory('all')
                setQuery('')
              },
            },
            '清除筛选',
          )
        : null,
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      LI(
        'button',
        { key: 'refresh', type: 'button', style: chip, disabled: loading, onClick: () => void refresh() },
        loading ? '刷新中…' : '刷新',
      ),
    ),
    LI(
      'div',
      { key: 'jql', style: { display: 'flex', alignItems: 'center', gap: 8 } },
      LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30, flex: 'none' } }, 'JQL'),
      LI('input', {
        key: 'input',
        value: jqlDraft,
        spellCheck: false,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          setJqlDraft(event.target.value)
          setEditingJql(true)
        },
        onBlur: () => {
          setEditingJql(false)
        },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key !== 'Enter') return
          setOverride(jqlDraft)
          setEditingJql(false)
        },
        style: {
          ...input,
          flex: '1 1 auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.78em',
        },
      }),
      override !== undefined && override !== configJql
        ? LI(
            'button',
            {
              key: 'reset',
              type: 'button',
              style: chip,
              title: '回到所选视图的查询',
              onClick: () => {
                setOverride(undefined)
              },
            },
            '重置',
          )
        : null,
    ),

    // Selection bar. Only present while a selection exists, so the board does
    // not carry a permanent toolbar for a mode nobody is in.
    checked.length > 0
      ? LI(
          'div',
          {
            key: 'selection',
            'data-dsh-jira-selection': '1',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              border: `1px solid ${C.accent}`,
              background: C.accentSoft,
              borderRadius: 9,
              padding: '6px 10px',
            },
          },
          LI('span', { key: 'count', style: { fontSize: '0.84em', fontWeight: 600, color: C.accent } }, `已选 ${String(checked.length)} 个`),
          LI(
            'span',
            {
              key: 'keys',
              style: {
                fontSize: '0.76em',
                color: C.textDim,
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            checked.join(' · '),
          ),
          LI('span', { key: 'spacer', style: { flex: 1 } }),
          LI(
            'button',
            {
              key: 'send',
              type: 'button',
              title: '选择目标工作区或会话',
              style: { ...chip, borderColor: C.accent, color: C.accent },
              onClick: (event: React.MouseEvent) => {
                const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: box.left, y: box.bottom + 6, keys: [...checked] })
              },
            },
            '交给 agent…',
          ),
          LI(
            'button',
            {
              key: 'new',
              type: 'button',
              style: chip,
              onClick: () => void dispatch([...checked], { kind: 'new-session' }),
            },
            '新建会话',
          ),
          LI(
            'button',
            { key: 'copy', type: 'button', style: chip, onClick: () => void copyPrompt([...checked]) },
            '复制提示词',
          ),
          LI(
            'button',
            {
              key: 'clear',
              type: 'button',
              style: chip,
              onClick: () => {
                setChecked([])
              },
            },
            '取消选择',
          ),
          LI('span', { key: 'hint', style: { fontSize: '0.74em', color: C.textFaint } }, 'Shift+点击 选择区间'),
        )
      : null,

    notice !== undefined
      ? LI(
          'div',
          {
            key: 'notice',
            style: {
              fontSize: '0.83em',
              color: notice.tone === 'ok' ? TONE_COLOR['ok'] : TONE_COLOR['bad'],
            },
          },
          notice.message,
        )
      : null,

    LI(
      'div',
      { key: 'cols', style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
      LI(
        'div',
        {
          key: 'track',
          'data-dsh-jira-cols': '1',
          style: {
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
            display: 'flex',
            gap: 12,
            paddingBottom: 16,
          },
        },
        body,
      ),
      selectedIssue !== undefined
        ? LI(IssueDrawer, {
            key: 'drawer',
            issue: selectedIssue,
            promptTemplate,
            onClose: () => {
              setSelected(undefined)
            },
            onRefreshBoard: () => {
              void refresh()
            },
            onNotify: notify,
          })
        : null,
    ),
    LI(
      'div',
      { key: 'foot', style: { fontSize: '0.74em', color: C.textFaint, paddingBottom: 8 } },
      board?.truncated === true ? `已达每次上限 ${String(board.limit)} 条，用 JQL 收窄范围 · ` : '',
      '右键卡片选择工作区/会话 · 拖住卡片可拖到看板图标 · 状态变更由你确认',
    ),

    menu !== undefined
      ? LI(CardMenu, {
          key: 'menu',
          issues: visible.filter((issue) => menu.keys.includes(issue.key)),
          choices,
          x: menu.x,
          y: menu.y,
          onPick: (target: HandOverTarget) => {
            void dispatch(menu.keys, target)
          },
          onClose: () => {
            setMenu(undefined)
          },
          onCopy: () => {
            void copyPrompt(menu.keys)
          },
        })
      : null,
  )
}

/**
 * The `sidebar.panellist` entry: the board's icon.
 *
 * A card dropped on this icon means "hand this issue to an agent": the icon
 * navigates to the board and selects that issue, whose drawer is where the
 * hand-over is actually offered. That keeps the destructive-ish step (starting
 * unattended work) an explicit click rather than a side effect of a drop.
 */
function BoardPanelIcon({ active, size }: { active?: boolean; size?: number }): React.ReactElement {
  const services = useHandover()
  const [over, setOver] = React.useState(false)
  const edge = typeof size === 'number' ? size : 18

  const accepts = (event: React.DragEvent): boolean =>
    event.dataTransfer !== null && event.dataTransfer.types.includes(DRAG_MIME)

  return LI(
    'span',
    {
      title: 'Jira 看板 · 把工单拖到这里交给 agent',
      'data-dsh-jira-drop': over ? '1' : '0',
      onDragOver: (event: React.DragEvent) => {
        // Only claim the drop when the payload is ours: claiming every drag
        // would swallow file drops meant for the composer.
        if (!accepts(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: () => {
        setOver(false)
      },
      onDrop: (event: React.DragEvent) => {
        setOver(false)
        if (!accepts(event)) return
        event.preventDefault()
        const raw = event.dataTransfer.getData(DRAG_MIME)
        if (raw === '') return
        let keys: readonly string[] = [raw]
        if (raw.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(raw)
            if (Array.isArray(parsed)) keys = parsed.filter((entry): entry is string => typeof entry === 'string')
          } catch {
            // A malformed payload falls back to the single key above.
          }
        }
        // Select the board panel first, then hand the payload over. The panel is
        // not mounted while another panel is selected, so the event has to wait
        // for it; the drop itself never dispatches, because "which conversation"
        // remains the user's choice.
        services.layout?.selectPanel?.(PANEL_ID)
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('dsh-jira-focus', { detail: { keys } }))
        }, 0)
      },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: edge,
        height: edge,
        color: active === true ? C.accent : 'inherit',
        borderRadius: 6,
      },
    },
    LI(
      'svg',
      {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      LI('rect', { key: 'a', x: 3, y: 4, width: 5.5, height: 16, rx: 1.5 }),
      LI('rect', { key: 'b', x: 10.5, y: 4, width: 5.5, height: 10, rx: 1.5 }),
      LI('path', { key: 'c', d: 'M18 8v5M15.5 10.5 18 13l2.5-2.5' }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Client plugin
// ---------------------------------------------------------------------------

export { AtlassianSettings, JiraBoardPanel, BoardPanelIcon }

/** Client-plane plugin name, used by the browser runtime's diagnostics. */
export const name = 'dsh-plugin-atlassian'

/** Services this client half resolves from the browser runtime. */
export const inject = ['slots']

/**
 * Mount the Settings page and the Jira board.
 *
 * `settings.section` is a list slot: a fresh `id` gets this page added beside
 * the shipped ones, while reusing a shipped id would replace that page — so the
 * id here is deliberately this plugin's own.
 *
 * `sidebar.panellist` is a root-scoped list whose ids address the keyed `main`
 * panel: registering the same id in both is what makes the sidebar icon open
 * this panel, with no navigation code of our own.
 */
export function apply(ctx: ClientContext): void {
  const withContext = (component: React.ComponentType<never>): React.ComponentType<never> => {
    // The slot component is created by us here, so its props are ours to
    // forward; the runtime supplies the shell's standard props, which the
    // component ignores.
    const inner = component as unknown as React.ComponentType<Record<string, unknown>>
    const Wrapped = (props: Record<string, unknown>): React.ReactElement =>
      LI(ContextRef.Provider, { value: ctx }, LI(inner, props))
    Wrapped.displayName = `atlassian(${inner.displayName ?? inner.name ?? 'slot'})`
    return Wrapped as unknown as React.ComponentType<never>
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'atlassian', order: 30, label: SECTION_LABEL },
      withContext(AtlassianSettings as unknown as React.ComponentType<never>),
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'Jira' },
      withContext(BoardPanelIcon as unknown as React.ComponentType<never>),
    ),
  )

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, withContext(JiraBoardPanel as unknown as React.ComponentType<never>)),
  )
}

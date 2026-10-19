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
 * A shell design token, with a legacy name and a literal fallback.
 *
 * The theme package defines its palette as `--dsw-alias-*` on `body`, and swaps
 * the whole set under the dark-theme attribute. Those aliases are what make one
 * stylesheet readable on both surfaces; a literal alone is a light-theme colour
 * and turns unreadable the moment the shell goes dark.
 *
 * The older `--text` / `--surface` names are kept inside the fallback chain in
 * case a host still exposes them, and the literal is the last resort for a shell
 * that defines neither — nothing better can be assumed at that point.
 */
function alias(name: string, legacy: string, fallback: string): string {
  return `var(--dsw-alias-${name}, var(--${legacy}, ${fallback}))`
}

/**
 * A semantic accent that keeps its hue but follows the surrounding text colour.
 *
 * `currentColor` is the inherited text colour, so the mix darkens a status colour
 * on a light background and lightens it on a dark one. That is one declaration
 * with no theme detection and no second palette to keep in sync; a browser that
 * cannot parse `color-mix` simply falls back to inherited colour.
 */
function tone(base: string, weight = 82): string {
  return `color-mix(in srgb, ${base} ${String(weight)}%, currentColor)`
}

const ACCENT = alias('link', 'accent', '#2f6fed')

const C = {
  text: alias('label-primary', 'text', '#1f2328'),
  textDim: alias('label-secondary', 'text-secondary', '#61666b'),
  textFaint: alias('label-tertiary', 'text-tertiary', '#81858c'),
  border: alias('border-l3', 'border', 'rgba(127,127,127,.28)'),
  borderSoft: alias('border-l2', 'border-subtle', 'rgba(127,127,127,.18)'),
  /** The panel's own background, for anything that must cover scrolled content. */
  surface: alias('bg-base', 'surface', '#ffffff'),
  /** A floating menu: the shell's translucent raised layer. */
  menu: `var(--dsw-specific-menu, ${alias('bg-layer-3', 'surface', '#ffffff')})`,
  /**
   * A picker's floating list, OPAQUE.
   *
   * `menu` is the shell's own translucent raised layer — fine for a menu that
   * floats over quiet chrome, but a picker opens directly over a wall of issue
   * cards, and the cards showed through as unreadable ghost text. The panel
   * surface is a solid token, so it is what the list must sit on.
   */
  pickerList: alias('bg-base', 'surface', '#ffffff'),
  surfaceSoft: 'var(--surface-subtle, rgba(127,127,127,.08))',
  surfaceHover: alias('interactive-bg-hover', 'surface-hover', 'rgba(127,127,127,.12)'),
  accent: ACCENT,
  accentSoft: `color-mix(in srgb, ${ACCENT} 14%, transparent)`,
} as const

const TONE_COLOR: Record<string, string> = {
  neutral: alias('label-tertiary', 'text-tertiary', '#81858c'),
  pending: tone('#c98a00'),
  ok: tone('#1a9e5c'),
  bad: tone('#d64545'),
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
[data-dsh-jira-board] :focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; border-radius: 6px; }
[data-dsh-jira-card] { transition: border-color .12s ease, background-color .12s ease; }
[data-dsh-jira-card]:hover { border-color: ${C.accent} !important; }
[data-dsh-jira-card][data-checked="0"]:hover { background: ${C.surfaceHover} !important; }
[data-dsh-jira-card][data-dragging="1"] { opacity: .45; }
[data-dsh-jira-board] button[aria-pressed="false"]:hover { background-color: ${C.surfaceHover} !important; }
[data-dsh-jira-board] button:not([aria-pressed]):hover:not(:disabled) { background-color: ${C.surfaceHover} !important; }
/* The pin sits inside a chip, so neither half may repaint the pill it lives in:
   a hover fill on the pin alone is the only affordance, and a pinned chip keeps
   its accent border while hovered. */
[data-dsh-jira-filter] { transition: border-color .12s ease; }
[data-dsh-jira-filter] > button { border-radius: 0 !important; }
[data-dsh-jira-pin]:hover { opacity: 1 !important; }
[data-dsh-jira-chip][data-pinned="1"]:hover { background-color: transparent !important; }
[data-dsh-jira-cols] { scrollbar-width: thin; scrollbar-color: ${C.border} transparent; }
[data-dsh-jira-cols]::-webkit-scrollbar { height: 8px; }
[data-dsh-jira-cols]::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 999px; }
[data-dsh-jira-cards] { scrollbar-width: thin; scrollbar-color: ${C.border} transparent; }
[data-dsh-jira-cards]::-webkit-scrollbar { width: 8px; }
[data-dsh-jira-cards]::-webkit-scrollbar-thumb { background: ${C.borderSoft}; border-radius: 999px; }
[data-dsh-jira-drop="1"] { outline: 2px dashed ${C.accent} !important; outline-offset: 1px; border-radius: 6px; }
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

type ConnectionTestVerdict =
  | 'valid'
  | 'refreshed'
  | 'invalid'
  | 'degraded'
  | 'unknown'
  | 'not-connected'

/** Mirrors `ConnectionTest` in `src/bridge.ts`. */
interface ConnectionTest {
  ok: boolean
  verdict: ConnectionTestVerdict
  checkedAt: string
  durationMs: number
  tool?: string
  site?: string
  message: string
}

/** Mirrors `BridgedTool` in `src/bridge.ts`. */
interface BridgedTool {
  name: string
  rawName: string
  description: string
}

const TEST_LABEL: Record<ConnectionTestVerdict, string> = {
  valid: 'Token 有效',
  refreshed: 'Token 已自动刷新',
  invalid: 'Token 已失效',
  degraded: '授权有效，但探测失败',
  unknown: '无法验证',
  'not-connected': '尚未连接',
}

const TEST_TONE: Record<ConnectionTestVerdict, string> = {
  valid: TONE_COLOR['ok'] ?? 'rgba(127,127,127,.9)',
  refreshed: TONE_COLOR['ok'] ?? 'rgba(127,127,127,.9)',
  invalid: TONE_COLOR['bad'] ?? 'rgba(127,127,127,.9)',
  degraded: TONE_COLOR['pending'] ?? 'rgba(127,127,127,.9)',
  unknown: TONE_COLOR['pending'] ?? 'rgba(127,127,127,.9)',
  'not-connected': TONE_COLOR['neutral'] ?? 'rgba(127,127,127,.9)',
}

interface BoardStatusInfo {
  name: string
  categoryKey: string
  categoryName: string
  colorName: string
}

/**
 * One sprint an issue belongs to, as the host flattened it.
 *
 * Jira keeps an array of these per issue; `state` is `active` / `future` /
 * `closed` (lower-cased), and an issue outside every sprint has no entries at
 * all.
 */
interface BoardSprint {
  id: string
  name: string
  state: string
  startDate?: string
  endDate?: string
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
  /** Sprints this issue belongs to, newest state first; empty when none. */
  sprints?: BoardSprint[]
  url?: string
}

interface BoardTransition {
  id: string
  name: string
  toName: string
  toCategoryKey: string
}

/** One project the authorization can see, as `GET /projects` lists it. */
interface BoardProject {
  key: string
  name: string
  /**
   * The site's own last-issue-update stamp for the project, which is what lets
   * the picker lead with "what changed lately" instead of an alphabetical wall.
   * Absent when the site reported no insight.
   */
  updated?: string
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
// Panel preference
// ---------------------------------------------------------------------------

/**
 * Whether the Jira panel is offered in the sidebar, and which projects are
 * pinned to the front of the board.
 *
 * The host owns both values so a choice follows the profile rather than one
 * browser tab's storage; this module keeps the last answer in memory because
 * two surfaces read it — the Settings switch and the slot registration itself,
 * which is not a React component.
 */
interface PanelPrefs {
  panelVisible: boolean
  /** Pinned project keys, in pin order (oldest pin first). */
  pinnedProjects: string[]
  /** Recently opened project keys, newest first. */
  recentProjects: string[]
}

interface PanelPrefsState {
  value: PanelPrefs
  /** The host has answered (or the request failed) and the switch may act. */
  loaded: boolean
}

/** Until the host says otherwise the panel is shown: refusing to register one over a transport error would be worse. */
const DEFAULT_PANEL_PREFS: PanelPrefs = { panelVisible: true, pinnedProjects: [], recentProjects: [] }

let panelPrefs: PanelPrefsState = { value: DEFAULT_PANEL_PREFS, loaded: false }
const panelPrefsListeners = new Set<() => void>()

function publishPanelPrefs(value: PanelPrefs, loaded: boolean): void {
  panelPrefs = { value, loaded }
  // Copy before iterating: a listener may dispose itself, or another one.
  for (const listener of [...panelPrefsListeners]) listener()
}

function subscribePanelPrefs(listener: () => void): () => void {
  panelPrefsListeners.add(listener)
  return () => {
    panelPrefsListeners.delete(listener)
  }
}

/**
 * Normalize whatever the host sent.
 *
 * `panelVisible`: anything but an explicit `false` means visible. The pinned
 * list is filtered down to keys that can be project keys, because it is opaque
 * deployment data by the time it reaches the browser and a malformed entry must
 * not become a chip with no project behind it.
 */
function panelPrefsOf(payload: { prefs?: PanelPrefs }): PanelPrefs {
  const keysOf = (value: unknown): string[] => {
    const keys: string[] = []
    if (!Array.isArray(value)) return keys
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const key = entry.trim().toUpperCase()
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue
      if (!keys.includes(key)) keys.push(key)
    }
    return keys
  }
  return {
    panelVisible: payload.prefs?.panelVisible !== false,
    pinnedProjects: keysOf(payload.prefs?.pinnedProjects),
    recentProjects: keysOf(payload.prefs?.recentProjects),
  }
}

/**
 * Read the stored preference once per page load.
 *
 * A failure is not surfaced: the endpoint is missing on an older host and the
 * request is fenced when nobody is signed in, and neither is a reason to show a
 * Settings error before the user has touched anything.
 */
async function loadPanelPrefs(): Promise<void> {
  try {
    const response = await api<{ ok: boolean; prefs: PanelPrefs }>('/prefs', 'GET')
    publishPanelPrefs(panelPrefsOf(response), true)
  } catch {
    publishPanelPrefs(panelPrefs.value, true)
  }
}

/** Persist a change and adopt what the host actually stored. */
async function savePanelVisible(visible: boolean): Promise<void> {
  const response = await api<{ ok: boolean; prefs: PanelPrefs }>('/prefs', 'POST', { panelVisible: visible })
  publishPanelPrefs(panelPrefsOf(response), true)
}

/**
 * Persist the pinned-project list and adopt the stored order.
 *
 * The response — not the value that was sent — becomes the new state: the host
 * normalizes, de-duplicates and caps the list, so echoing the request back
 * would let a divergence between the two surfaces go unnoticed until reload.
 */
async function savePinnedProjects(pinned: readonly string[]): Promise<void> {
  const response = await api<{ ok: boolean; prefs: PanelPrefs }>('/prefs', 'POST', { pinnedProjects: [...pinned] })
  publishPanelPrefs(panelPrefsOf(response), true)
}

/**
 * Persist the recently-opened list and adopt the stored order.
 *
 * Written on every project switch, so it is fire-and-forget: a failed write must
 * not interrupt the click, and the in-memory list already reflects the choice.
 * The response still becomes the new state when it arrives, because the host
 * normalizes and caps the list.
 */
async function saveRecentProjects(recent: readonly string[]): Promise<void> {
  const response = await api<{ ok: boolean; prefs: PanelPrefs }>('/prefs', 'POST', { recentProjects: [...recent] })
  publishPanelPrefs(panelPrefsOf(response), true)
}

/**
 * Move one project key to the end of the pinned list, or take it out.
 *
 * Pure, so the order contract is testable without a browser: pinning APPENDS,
 * which is what makes "pin them in the order you clicked" true, and the same
 * call with the key already present removes it — a pin has to be reversible
 * from the chip that created it.
 */
function togglePinned(pinned: readonly string[], key: string): string[] {
  const existing = pinned.filter((entry) => entry !== key)
  return existing.length === pinned.length ? [...pinned, key] : existing
}

/**
 * Move one project key to the FRONT of the recent list.
 *
 * Newest first is the whole contract: the strip answers "where was I", so the
 * project just opened has to lead it. A repeat moves the existing entry rather
 * than duplicating it, and the list is bounded so it stays a strip.
 *
 * Pure for the same reason `togglePinned` is: this ordering is the feature.
 */
const MAX_RECENT_PROJECTS = 8

function pushRecent(recent: readonly string[], key: string): string[] {
  const next = [key, ...recent.filter((entry) => entry !== key)]
  return next.slice(0, MAX_RECENT_PROJECTS)
}

/** The shared preference, observable from React. */
function usePanelPrefs(): PanelPrefsState {
  const [state, setState] = React.useState(panelPrefs)
  React.useEffect(() => {
    setState(panelPrefs)
    return subscribePanelPrefs(() => {
      setState(panelPrefs)
    })
  }, [])
  return state
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

/**
 * A boolean preference switch.
 *
 * A button with `role="switch"` rather than a checkbox: the track and knob are
 * pure layout, and a native checkbox would need the same properties plus a
 * cross-browser `appearance` reset.
 */
function Switch({
  checked,
  busy,
  label,
  onChange,
}: {
  checked: boolean
  busy: boolean
  label: string
  onChange: () => void
}): React.ReactElement {
  return LI(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      title: label,
      disabled: busy,
      onClick: onChange,
      style: {
        position: 'relative',
        flex: 'none',
        width: 40,
        height: 23,
        padding: 0,
        borderRadius: 999,
        border: `1px solid ${checked ? C.accent : C.border}`,
        background: checked ? C.accent : 'transparent',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.55 : 1,
        transition: 'background-color .16s ease, border-color .16s ease, opacity .16s ease',
      },
    },
    LI('span', {
      key: 'knob',
      style: {
        position: 'absolute',
        top: 3,
        left: checked ? 20 : 3,
        width: 15,
        height: 15,
        borderRadius: 999,
        background: checked ? '#fff' : C.textFaint,
        boxShadow: checked ? '0 1px 2px rgba(0,0,0,.32)' : 'none',
        transition: 'left .16s ease, background-color .16s ease',
      },
    }),
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
  /** Fiber-scoped cleanup, when the runtime exposes it (Cordis does). */
  effect?(work: () => (() => void) | undefined, label?: string): void
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
        background: C.menu,
        backdropFilter: 'blur(12px)',
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        boxShadow: '0 14px 34px rgba(0,0,0,.28)',
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

/**
 * The last `/status` answer, so reopening a panel does not blank its header.
 *
 * A cache, never a source of truth: it expires after one slow-poll period and
 * every explicit `refresh()` overwrites it.
 */
let lastStatus: { payload: StatusPayload; at: number } | undefined

/** One slow-poll period: a read that old is due on the next tick anyway. */
const STATUS_CACHE_TTL = 8_000

/** Poll the host's status; fast while authorization is in flight, slow after. */
function useStatus(): {
  payload: StatusPayload | undefined
  transportError: string | undefined
  refresh: () => Promise<void>
} {
  const [payload, setPayload] = React.useState<StatusPayload | undefined>(() => lastStatus?.payload)
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
        lastStatus = { payload: next, at: Date.now() }
      }
    } catch (error) {
      if (mounted.current && ticket === sequence.current) {
        setTransportError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [])

  React.useEffect(() => {
    // A snapshot younger than the poll period answers what the next tick would
    // ask, so reopening a panel does not blank its header just to re-read it.
    const at = lastStatus?.at
    if (at !== undefined && Date.now() - at < STATUS_CACHE_TTL) return
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
  const panel = usePanelPrefs()
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [test, setTest] = React.useState<ConnectionTest | undefined>(undefined)
  const [panelBusy, setPanelBusy] = React.useState(false)
  const [panelError, setPanelError] = React.useState<string | undefined>(undefined)
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [tools, setTools] = React.useState<BridgedTool[] | undefined>(undefined)
  const [toolsLoading, setToolsLoading] = React.useState(false)
  const [toolsError, setToolsError] = React.useState<string | undefined>(undefined)
  const [toolQuery, setToolQuery] = React.useState('')
  const mounted = React.useRef(true)
  /** Bumped whenever the tool generation changes, so a stale fetch cannot land. */
  const toolEpoch = React.useRef(0)

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

  // The catalogue is fetched on first expand, not with the status poll: 197
  // descriptions would dominate a payload that is refreshed every few seconds.
  const loadTools = React.useCallback(async (): Promise<void> => {
    const ticket = toolEpoch.current
    setToolsLoading(true)
    setToolsError(undefined)
    try {
      const response = await api<{ ok: boolean; tools: BridgedTool[] }>('/tools', 'GET')
      if (mounted.current && ticket === toolEpoch.current) setTools(response.tools)
    } catch (error) {
      if (mounted.current && ticket === toolEpoch.current) {
        setToolsError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mounted.current && ticket === toolEpoch.current) setToolsLoading(false)
    }
  }, [])

  const toggleTools = React.useCallback((): void => {
    const next = !toolsOpen
    setToolsOpen(next)
    if (next && tools === undefined && !toolsLoading) void loadTools()
  }, [toolsOpen, tools, toolsLoading, loadTools])

  const act = React.useCallback(
    async (action: 'connect' | 'disconnect'): Promise<void> => {
      setBusy(true)
      // A verdict about the previous connection would outlive the connection it
      // described; clear it before changing that connection. The tool catalogue
      // belongs to the same generation, so it goes too.
      setTest(undefined)
      toolEpoch.current += 1
      setTools(undefined)
      setToolsError(undefined)
      setToolsLoading(false)
      setToolsOpen(false)
      setToolQuery('')
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

  const runTest = React.useCallback(async (): Promise<void> => {
    setTesting(true)
    setTest(undefined)
    try {
      const response = await api<{ ok: boolean; test: ConnectionTest }>('/test', 'POST')
      if (mounted.current) {
        setTest(response.test)
        // `invalid` unregisters every tool server-side, so a catalogue already
        // on screen would describe a generation that no longer exists.
        if (response.test.verdict === 'invalid') {
          toolEpoch.current += 1
          setTools(undefined)
          setToolsLoading(false)
          setToolsOpen(false)
          setToolQuery('')
        }
      }
    } catch (error) {
      if (mounted.current) {
        setTest({
          ok: false,
          verdict: 'unknown',
          checkedAt: new Date().toISOString(),
          durationMs: 0,
          message: `无法发起测试：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    } finally {
      if (mounted.current) setTesting(false)
      // An invalid verdict clears the token and unregisters the tools, so the
      // page must re-read the snapshot rather than keep showing "connected".
      await refresh()
    }
  }, [refresh])

  /**
   * Flip the sidebar entry.
   *
   * Pessimistic on purpose: the host owns the document, and painting the new
   * state before that write succeeds would show a switch that disagrees with
   * the sidebar. A failed write leaves the switch where it was and says why.
   */
  const togglePanel = React.useCallback(async (): Promise<void> => {
    if (panelBusy || !panel.loaded) return
    setPanelBusy(true)
    setPanelError(undefined)
    try {
      await savePanelVisible(!panel.value.panelVisible)
    } catch (failure) {
      setPanelError(`保存失败：${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      if (mounted.current) setPanelBusy(false)
    }
  }, [panelBusy, panel.loaded, panel.value.panelVisible])

  const status = payload?.status ?? 'idle'
  const authorizationUrl = payload?.authorizationUrl
  const error = transportError ?? payload?.error
  const toolCount = payload?.toolCount ?? 0

  const filteredTools = React.useMemo(() => {
    const list = tools ?? []
    const needle = toolQuery.trim().toLowerCase()
    if (needle === '') return list
    return list.filter((tool) =>
      `${tool.name}\n${tool.rawName}\n${tool.description}`.toLowerCase().includes(needle),
    )
  }, [tools, toolQuery])

  // Losing every tool (disconnect, or a probe that invalidated the token) makes
  // an open catalogue describe a generation that no longer exists.
  React.useEffect(() => {
    if (toolCount === 0) setToolsOpen(false)
  }, [toolCount])

  const hintStyle: React.CSSProperties = { padding: '12px 2px', fontSize: '0.82em', opacity: 0.7 }

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
      '一次浏览器授权后，Jira、Confluence、Bitbucket、Goals、Projects 与 Loom 的工具会作为原生工具出现在 agent 的工具列表里，侧边栏也会多出一块 Jira 看板（可在下面的「侧边栏入口」里关掉）。',
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
      { key: 'actions', style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
      LI(
        'button',
        {
          key: 'connect',
          type: 'button',
          style: { ...button, opacity: busy || testing || status === 'ready' ? 0.5 : 1 },
          disabled: busy || testing || status === 'ready',
          onClick: () => {
            void act('connect')
          },
        },
        status === 'authorizing' ? '打开授权页' : '连接 Atlassian',
      ),
      LI(
        'button',
        {
          key: 'test',
          type: 'button',
          title:
            status === 'ready'
              ? '调用一次只读工具，验证当前令牌是否仍被 Atlassian 接受'
              : '连接建立后才能测试',
          style: { ...button, opacity: status === 'ready' && !busy && !testing ? 1 : 0.5 },
          disabled: status !== 'ready' || busy || testing,
          onClick: () => {
            void runTest()
          },
        },
        testing ? '测试中…' : '测试连接',
      ),
      LI(
        'button',
        {
          key: 'disconnect',
          type: 'button',
          style: { ...button, opacity: busy || testing || status === 'idle' ? 0.5 : 1 },
          disabled: busy || testing || status === 'idle',
          onClick: () => {
            void act('disconnect')
          },
        },
        '断开连接',
      ),
    ),
    test === undefined
      ? null
      : LI(
          'div',
          {
            key: 'test-result',
            role: 'status',
            style: { ...box, marginTop: 14, marginBottom: 0, borderColor: TEST_TONE[test.verdict] },
          },
          LI(
            'div',
            {
              key: 'head',
              style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
            },
            LI('span', {
              key: 'dot',
              style: {
                width: 8,
                height: 8,
                borderRadius: 999,
                background: TEST_TONE[test.verdict],
                flex: 'none',
              },
            }),
            LI(
              'span',
              { key: 'label', style: { fontWeight: 600, fontSize: '0.9em', color: TEST_TONE[test.verdict] } },
              TEST_LABEL[test.verdict],
            ),
            LI(
              'span',
              { key: 'meta', style: { marginLeft: 'auto', fontSize: '0.78em', color: C.textFaint } },
              `${String(test.durationMs)} ms · ${relativeTime(test.checkedAt)}`,
            ),
          ),
          LI(
            'div',
            { key: 'message', style: { fontSize: '0.86em', lineHeight: 1.6, overflowWrap: 'anywhere' } },
            test.message,
          ),
          test.tool === undefined
            ? null
            : LI(
                'div',
                { key: 'tool', style: { marginTop: 6, fontSize: '0.78em', color: C.textFaint } },
                `探测工具 ${test.tool}${test.site === undefined ? '' : ` · ${test.site}`}`,
              ),
        ),
    // A UI preference, not a connection setting: it stays usable while the
    // token is dead, because hiding the panel does not depend on Atlassian.
    LI(
      'div',
      { key: 'panel-pref', style: { ...box, marginTop: 14, marginBottom: 0 } },
      LI(
        'div',
        { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 14 } },
        LI(
          'div',
          { key: 'copy', style: { flex: 1, minWidth: 0 } },
          LI('div', { key: 'title', style: { fontSize: '0.9em', fontWeight: 600 } }, '侧边栏入口'),
          LI(
            'div',
            { key: 'hint', style: { marginTop: 3, fontSize: '0.8em', color: C.textFaint, lineHeight: 1.5 } },
            panel.loaded
              ? '关闭后侧边栏不再显示 Jira 图标；看板数据与 agent 工具都不会受影响，随时可以再打开。'
              : '读取中…',
          ),
        ),
        LI(Switch, {
          key: 'switch',
          checked: panel.value.panelVisible,
          busy: panelBusy || !panel.loaded,
          label: '在侧边栏显示 Jira 面板',
          onChange: () => {
            void togglePanel()
          },
        }),
      ),
      panelError === undefined
        ? null
        : LI('div', { key: 'error', style: { marginTop: 8, fontSize: '0.8em', color: TONE_COLOR['bad'] } }, panelError),
    ),
    LI(
      'div',
      { key: 'tool-catalog', style: { ...box, marginTop: 14, marginBottom: 0 } },
      LI(
        'div',
        { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        LI(
          'div',
          { key: 'titles', style: { flex: 1, minWidth: 0 } },
          LI('div', { key: 'title', style: { fontSize: '0.9em', fontWeight: 600 } }, '工具清单'),
          LI(
            'div',
            { key: 'sub', style: { marginTop: 2, fontSize: '0.8em', opacity: 0.62 } },
            toolCount === 0
              ? '连接后这里会列出服务端提供的全部工具及说明。'
              : `共 ${String(toolCount)} 个工具，展开后可搜索名称与说明。`,
          ),
        ),
        LI(
          'button',
          {
            key: 'toggle',
            type: 'button',
            style: { ...button, opacity: toolCount === 0 ? 0.5 : 1 },
            disabled: toolCount === 0,
            onClick: toggleTools,
          },
          toolsOpen ? '收起' : '查看工具',
        ),
      ),
      toolsOpen
        ? LI(
            'div',
            { key: 'panel' },
            LI(
              'div',
              { key: 'search', style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 } },
              LI('input', {
                key: 'q',
                type: 'search',
                'aria-label': '搜索工具',
                value: toolQuery,
                placeholder: '搜索工具名或说明…',
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  setToolQuery(event.target.value)
                },
                style: { ...input, flex: 1 },
              }),
              LI(
                'span',
                { key: 'n', style: { fontSize: '0.78em', color: C.textFaint, whiteSpace: 'nowrap' } },
                `${String(filteredTools.length)} / ${String(tools?.length ?? toolCount)}`,
              ),
            ),
            LI(
              'div',
              {
                key: 'list',
                style: {
                  marginTop: 10,
                  maxHeight: 420,
                  overflowY: 'auto',
                  borderTop: `1px solid ${C.borderSoft}`,
                },
              },
              toolsLoading
                ? LI('div', { key: 'loading', style: hintStyle }, '读取工具清单…')
                : toolsError !== undefined
                  ? LI(
                      'div',
                      { key: 'error', style: { ...hintStyle, color: TONE_COLOR['bad'] } },
                      toolsError,
                      ' ',
                      LI(
                        'button',
                        {
                          key: 'retry',
                          type: 'button',
                          style: { ...chip, marginLeft: 6 },
                          onClick: () => {
                            void loadTools()
                          },
                        },
                        '重试',
                      ),
                    )
                  : filteredTools.length === 0
                    ? LI(
                        'div',
                        { key: 'empty', style: hintStyle },
                        toolQuery.trim() === '' ? '当前没有已注册的工具。' : '没有匹配的工具。',
                      )
                    : filteredTools.map((tool) =>
                        LI(
                          'div',
                          {
                            key: tool.name,
                            style: { padding: '9px 2px', borderBottom: `1px solid ${C.borderSoft}` },
                          },
                          LI(
                            'div',
                            {
                              key: 'name',
                              title: tool.rawName,
                              style: {
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                fontSize: '0.8em',
                                fontWeight: 600,
                                overflowWrap: 'anywhere',
                              },
                            },
                            tool.name,
                          ),
                          LI(
                            'div',
                            {
                              key: 'desc',
                              style: {
                                marginTop: 4,
                                fontSize: '0.8em',
                                lineHeight: 1.55,
                                opacity: 0.72,
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                              },
                            },
                            tool.description === '' ? '（服务端没有提供说明）' : tool.description,
                          ),
                        ),
                      ),
            ),
          )
        : null,
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
  new: alias('label-tertiary', 'text-tertiary', '#81858c'),
  indeterminate: tone('#c98a00'),
  done: tone('#1a9e5c'),
  undefined: alias('label-tertiary', 'text-tertiary', '#81858c'),
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
  const base = PROJECT_PALETTE[hash % PROJECT_PALETTE.length]
  return base === undefined ? C.accent : tone(base)
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

/** Jira's own "assigned to me" clause, resolved server-side against the token. */
const MINE_CLAUSE = 'assignee = currentUser()'

const MINE_PATTERN = /assignee\s*=\s*currentUser\s*\(\s*\)/i
/**
 * Insert one clause into the WHERE part of a query.
 *
 * JQL requires `ORDER BY` to be last, so a constraint has to land before it. A
 * query that is nothing but an ORDER BY must not gain a leading `AND` either,
 * which is why the empty head is handled explicitly.
 */
function foldClause(jql: string, clause: string): string {
  const trimmed = jql.trim()
  if (trimmed === '') return clause
  const order = /\border\s+by\b/i.exec(trimmed)
  if (order === null) return `${trimmed} AND ${clause}`
  const head = trimmed.slice(0, order.index).trimEnd()
  const tail = trimmed.slice(order.index)
  return head === '' ? `${clause} ${tail}` : `${head} AND ${clause} ${tail}`
}

/**
 * Fold the "assigned to me" constraint into a query.
 *
 * Server-side rather than a chip over the loaded page: the board fetches one
 * bounded page, so filtering the 50 issues it happens to hold would report
 * "nothing assigned to me" for a user whose work simply is not in that page.
 * `currentUser()` is also the only correct way to ask — the panel never learns
 * its own display name, and matching one would break on a rename.
 *
 * The fold is idempotent: a query that already pins the assignee — including
 * one the user typed into the JQL box — is returned unchanged, so toggling the
 * chip over a hand-written query cannot duplicate the condition.
 */
function withMine(jql: string, mine: boolean): string {
  if (!mine) return jql
  const trimmed = jql.trim()
  if (MINE_PATTERN.test(trimmed)) return trimmed
  return foldClause(trimmed, MINE_CLAUSE)
}

/**
 * The project clause a selectable project stands for.
 *
 * A project is mandatory, so this is never the "all projects" case: the board
 * always reads one project at a time, and the JQL says which. That is what makes
 * the issue count in the row truthful — it is the project's own count, not the
 * first page of a site-wide query.
 *
 * Keys are `[A-Za-z][A-Za-z0-9_]*` in Jira, so the value is emitted bare; a
 * quoted form is still accepted on read (`project = "DEMO"`), because a
 * hand-written query may carry one.
 */
function projectClauseOf(project: string): string {
  const key = project.trim()
  if (key === '') return ''
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(key) ? `project = ${key}` : `project = "${key.replace(/"/g, '\\"')}"`
}

/** Any `project` restriction in the query, whatever its operator. */
const PROJECT_CLAUSE_PATTERN = /\bproject\s*(?:=|!=|in\b|not\s+in\b|is\b)/i

/** The exact project key a `project = KEY` clause names, when it names one. */
const PROJECT_EQUALS_PATTERN = /\bproject\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?/i

/**
 * Fold the selected project into a query.
 *
 * The project is the board's SCOPE, not another optional filter, so it has to be
 * in the JQL: the server must page that project's issues, not hand back one page
 * of a site-wide query the panel then filters.
 *
 * A single `project = KEY` already in the query is REWRITTEN rather than kept,
 * because the chip is the selection the user is looking at — leaving a stale
 * key in place would make clicking a project chip appear to do nothing. A
 * SET-shaped restriction (`project in (...)`, `project != X`) is left alone: it
 * is a deliberate multi-project question one chip cannot express, and folding a
 * second clause onto it would turn it into a contradiction.
 */
function withProject(jql: string, project: string): string {
  const clause = projectClauseOf(project)
  if (clause === '') return jql
  const trimmed = jql.trim()
  if (PROJECT_EQUALS_PATTERN.test(trimmed)) {
    return trimmed.replace(PROJECT_EQUALS_PATTERN, clause)
  }
  if (PROJECT_CLAUSE_PATTERN.test(trimmed)) return trimmed
  return foldClause(trimmed, clause)
}

/**
 * What the JQL itself says about the project chip.
 *
 * Mirrors `sprintFilterOf`: committing a hand-written query must not leave a
 * chip highlighted for a project the query no longer names. Returns '' when the
 * query restricts projects in a way one chip cannot express (`project in (A,B)`),
 * which is the honest answer — the query is the truth, the row just stops
 * claiming one of them.
 */
function projectFilterOf(jql: string): string {
  if (!PROJECT_CLAUSE_PATTERN.test(jql)) return ''
  const exact = PROJECT_EQUALS_PATTERN.exec(jql)
  return exact?.[1] === undefined ? '' : exact[1].toUpperCase()
}

/**
 * The sprint filter, as a string so it can live in the snapshot.
 *
 * `'all'`, `'open'` (Jira's own open sprints), `'empty'` (not in any sprint) or
 * `'id:<sprintId>'` for one exact sprint.
 */
const SPRINT_ALL = 'all'
const SPRINT_OPEN = 'open'
const SPRINT_EMPTY = 'empty'
const SPRINT_ID_PREFIX = 'id:'

/**
 * The JQL clause a sprint selection stands for, or '' for no constraint.
 *
 * Sprint filtering is SERVER-side for the same reason "assigned to me" is: the
 * board holds one bounded page, and a sprint whose issues fall outside that page
 * would read as an empty sprint.
 *
 * `sprint = <id>` is the exact-sprint form and is what a catalogue chip emits.
 * An id is numeric in practice, but a name is accepted too — a hand-edited
 * selection or a board that only carries names must still produce valid JQL,
 * which means quoting it rather than letting Jira parse a bare word.
 */
function sprintClauseOf(selection: string): string {
  if (selection === SPRINT_OPEN) return 'sprint IN openSprints()'
  if (selection === SPRINT_EMPTY) return 'sprint IS EMPTY'
  if (selection.startsWith(SPRINT_ID_PREFIX)) {
    const id = selection.slice(SPRINT_ID_PREFIX.length).trim()
    if (id === '') return ''
    if (/^\d+$/.test(id)) return `sprint = ${id}`
    return `sprint = "${id.replace(/"/g, '\\"')}"`
  }
  return ''
}

/** Fold a sprint selection into a query; `all` leaves it untouched. */
function withSprint(jql: string, selection: string): string {
  const clause = sprintClauseOf(selection)
  return clause === '' ? jql : foldClause(jql, clause)
}

/**
 * What the JQL itself says about the sprint filter.
 *
 * Seeding the chip from the query is what stops the row from claiming "全部"
 * while the board is constrained by a hand-written `sprint = 12` — the same
 * contract the "assigned to me" chip keeps. A quoted id is accepted too, since
 * that is the form a name-shaped selection produces.
 */
function sprintFilterOf(jql: string): string {
  if (/\bsprint\s+in\s+openSprints\s*\(\s*\)/i.test(jql)) return SPRINT_OPEN
  if (/\bsprint\s+(?:is\s+empty|=\s*empty)/i.test(jql)) return SPRINT_EMPTY
  const equal = /\bsprint\s*=\s*"?([^"\s)]+)"?/i.exec(jql)
  return equal?.[1] === undefined ? SPRINT_ALL : `${SPRINT_ID_PREFIX}${equal[1]}`
}

/** One selectable sprint, as the server's catalogue describes it. */
interface SprintOption {
  id: string
  name: string
  state: string
  startDate?: string
  endDate?: string
  boardId?: string
  boardName?: string
}

/** A catalogue entry plus how many cards on this page carry it. */
interface SprintChoice extends SprintOption {
  count: number
}

/** The state label a sprint chip's tooltip shows. */
function sprintStateLabel(state: string): string {
  if (state === 'active') return '进行中'
  if (state === 'future') return '未开始'
  if (state === 'closed') return '已结束'
  return '状态未知'
}

/**
 * Merge the server's sprint catalogue with what the page shows.
 *
 * The catalogue is the authority for WHICH sprints exist — a project's sprints
 * are an enumerable list of named options, not a property an issue happens to
 * have, and a closed sprint the user still wants to filter by need not appear
 * on the current page at all. The loaded page contributes only the counts, and
 * any sprint it carries that the catalogue missed (a board the caller cannot
 * read, a page loaded before the catalogue arrived) is appended so nothing is
 * silently unfilterable.
 *
 * Ordering: active → future → closed, then most recent end date first, then by
 * name. A project with 160 sprints must open on the ones that matter.
 */
function sprintChoices(
  catalogue: readonly SprintOption[],
  issues: readonly BoardIssue[],
): SprintChoice[] {
  const counts = new Map<string, number>()
  for (const issue of issues) {
    for (const sprint of issue.sprints ?? []) {
      const id = sprint.id === '' ? sprint.name : sprint.id
      if (id === '') continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }

  const merged = new Map<string, SprintOption>()
  for (const option of catalogue) {
    if (option.id === '') continue
    merged.set(option.id, option)
  }
  for (const issue of issues) {
    for (const sprint of issue.sprints ?? []) {
      const id = sprint.id === '' ? sprint.name : sprint.id
      if (id === '' || merged.has(id)) continue
      merged.set(id, { id, name: sprint.name === '' ? id : sprint.name, state: sprint.state })
    }
  }

  const rank = (state: string): number => (state === 'active' ? 0 : state === 'future' ? 1 : 2)
  const endedAt = (option: SprintOption): number => {
    const time = option.endDate === undefined ? Number.NaN : Date.parse(option.endDate)
    return Number.isNaN(time) ? 0 : time
  }
  return [...merged.values()]
    .map((option) => ({ ...option, count: counts.get(option.id) ?? 0 }))
    .sort(
      (left, right) =>
        rank(left.state) - rank(right.state) ||
        endedAt(right) - endedAt(left) ||
        left.name.localeCompare(right.name),
    )
}

/** The `PROJECT-123` part of a regex match, upper-cased the way Jira writes it. */
function keyOfMatch(match: RegExpExecArray): string | undefined {
  const project = match[1]
  const number = match[2]
  if (project === undefined || number === undefined) return undefined
  // Jira keys are upper-case; typing one in lower-case is common and still exact.
  return `${project.toUpperCase()}-${number}`
}

/**
 * The one issue a search-box query NAMES, when it names one.
 *
 * The board filters the page it already holds, which is instant but blind to
 * everything outside that page — and `HMHP-111` typed into it used to answer
 * "没有工单" for an issue that plainly exists. A bare key or a pasted Jira link
 * is not a substring filter, it is an exact question, so it is answered by the
 * server instead (see `GET /issue/<key>`).
 *
 * Only those two shapes are recognized. A key buried in prose stays an ordinary
 * substring search: guessing which word of a sentence is the key would turn
 * searching the board into surprise navigation.
 */
function issueKeyOf(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const bare = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(trimmed)
  if (bare !== null) return keyOfMatch(bare)
  // A link has to look like one before it is scanned: a summary is allowed to
  // contain `browse`, a URL is not.
  const looksLikeLink =
    /^https?:\/\//i.test(trimmed) || /\/(?:browse|issues)\//i.test(trimmed) || /[?&]selectedIssue=/i.test(trimmed)
  if (!looksLikeLink) return undefined
  // Jira carries the key in the browse path, in `selectedIssue`, or (newer
  // sites) in an `/issues/` path; the query string may also be percent-encoded.
  const inUrl = /(?:\/browse\/|[?&]selectedIssue=|\/issues\/)([A-Za-z][A-Za-z0-9_]*)-(\d+)/i.exec(
    decodeURIComponent(trimmed),
  )
  return inUrl === null ? undefined : keyOfMatch(inUrl)
}

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

/**
 * The sprint label a card shows, if any.
 *
 * The active sprint wins over every other one — that is the sprint the work is
 * being done in — and a closed sprint is only shown when it is all the issue
 * has. Returns undefined for an issue outside every sprint, which is ordinary
 * on a kanban board and must not render an empty pill.
 */
function sprintBadge(issue: BoardIssue): { label: string; title: string } | undefined {
  const sprints = issue.sprints ?? []
  if (sprints.length === 0) return undefined
  const active = sprints.find((entry) => entry.state === 'active')
  const chosen = active ?? sprints[0]
  if (chosen === undefined) return undefined
  const state = chosen.state === 'active' ? '进行中' : chosen.state === 'future' ? '未开始' : chosen.state === 'closed' ? '已结束' : ''
  return {
    label: chosen.name === '' ? chosen.id : chosen.name,
    title: `冲刺：${chosen.name}${state === '' ? '' : `（${state}）`}${active === undefined ? '' : ' · 当前冲刺'}`,
  }
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

/**
 * A selectable filter chip carrying its own count.
 *
 * The pill is a wrapper with up to TWO real buttons inside it — the filter and,
 * for a project, its pin. Neither can be nested in the other: a `<button>`
 * cannot contain another interactive element, and a `role="button"` span inside
 * one produces a control screen readers announce twice and some browsers refuse
 * to route a click to. The wrapper carries the border so the pair still reads
 * as one chip.
 */
function FilterChip({
  active,
  label,
  count,
  tone,
  title,
  pinned,
  onPin,
  onClick,
}: {
  active: boolean
  label: string
  count?: number | undefined
  tone?: string | undefined
  title?: string | undefined
  /**
   * Whether this chip's project is pinned to the front of the row.
   *
   * `undefined` means "this chip cannot be pinned" (the status chips, for
   * instance): the affordance only exists where the pin actually means
   * something, rather than being offered and then ignored.
   */
  pinned?: boolean | undefined
  /** Toggle the pin. Only rendered when `pinned` is defined. */
  onPin?: (() => void) | undefined
  onClick: () => void
}): React.ReactElement {
  const color = tone ?? C.accent
  const pinnable = pinned !== undefined && onPin !== undefined
  return LI(
    'span',
    {
      'data-dsh-jira-filter': '1',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${active ? color : pinned === true ? C.accent : C.border}`,
        background: active ? C.accentSoft : 'transparent',
        borderRadius: 999,
        // The wrapper owns the shape; the buttons inside must not repaint it.
        overflow: 'hidden',
      },
    },
    LI(
      'button',
      {
        key: 'chip',
        type: 'button',
        title,
        'aria-pressed': active,
        'data-dsh-jira-chip': pinnable ? 'project' : 'filter',
        'data-pinned': pinned === undefined ? '' : pinned ? '1' : '0',
        onClick,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: 'none',
          background: 'transparent',
          color: active ? color : C.textDim,
          padding: `3px ${String(pinnable ? 4 : 10)}px`,
          paddingLeft: 10,
          fontSize: '0.8em',
          cursor: 'pointer',
          fontWeight: active || pinned === true ? 600 : 400,
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
    ),
    pinnable
      ? LI(
          'button',
          {
            key: 'pin',
            type: 'button',
            'data-dsh-jira-pin': pinned ? '1' : '0',
            title: pinned ? `取消固定 ${label}` : `固定 ${label} 到项目行最前`,
            'aria-pressed': pinned,
            'aria-label': pinned ? `取消固定 ${label}` : `固定 ${label} 到项目行最前`,
            onClick: (event: React.MouseEvent) => {
              // Independent target: pinning must not also narrow the board.
              event.stopPropagation()
              onPin()
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              // A hairline separates the two targets, so the pin cannot be hit
              // by accident while aiming at the project name.
              borderLeft: `1px solid ${pinned ? color : C.borderSoft}`,
              padding: '3px 7px',
              cursor: 'pointer',
              color: pinned ? color : C.textFaint,
              opacity: pinned ? 1 : 0.6,
              fontSize: '0.62em',
              lineHeight: 1,
              font: 'inherit',
            },
          },
          // Filled when pinned, hollow when not: the state has to survive being
          // rendered at a fraction of the chip's font size.
          pinned ? '●' : '○',
        )
      : null,
  )
}

/**
 * The full project catalogue as a searchable picker.
 *
 * A chip per project is wrong on a real site: this site lists 148 of them, and
 * the ones anybody reads are a handful. So the row shows only the RECENT and
 * PINNED projects, and the entire catalogue lives behind this control — which
 * filters as you type and reports how much it is narrowing.
 *
 * Sorted by the site's own `lastIssueUpdateTime` first (projects that moved
 * recently lead), then by key: "which project should I open" is far better
 * answered by "what changed lately" than by an alphabetical wall.
 */
function ProjectPicker({
  options,
  value,
  onPick,
}: {
  options: readonly BoardProject[]
  /** The current selection, or '' before one is chosen. */
  value: string
  onPick: (key: string) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [needle, setNeedle] = React.useState('')
  const box = React.useRef<HTMLDivElement | undefined>(undefined)

  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const node = box.current
      if (node !== undefined && event.target instanceof Node && node.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Recently-updated first, then key. An unparsable or missing timestamp sorts
  // to the end: "no evidence of recency" must not outrank a project that really
  // did move yesterday.
  const ranked = React.useMemo(() => {
    const stamp = (entry: BoardProject): number => {
      const at = entry.updated === undefined ? Number.NaN : Date.parse(entry.updated)
      return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
    }
    return [...options].sort((a, b) => stamp(b) - stamp(a) || a.key.localeCompare(b.key))
  }, [options])

  const term = needle.trim().toLowerCase()
  const matches =
    term === ''
      ? ranked
      : ranked.filter((entry) => `${entry.key} ${entry.name}`.toLowerCase().includes(term))
  // Capped so a 148-project site does not paint 148 rows: the search box is how
  // the rest is reached, and the footer says how many are hidden.
  const MAX_ROWS = 40
  const shown = matches.slice(0, MAX_ROWS)

  return LI(
    'div',
    { ref: box, 'data-dsh-jira-project-picker': '1', style: { position: 'relative', display: 'inline-flex' } },
    LI(
      'button',
      {
        key: 'toggle',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        title: `在全部 ${String(options.length)} 个项目中查找`,
        onClick: () => {
          setOpen(!open)
          setNeedle('')
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: `1px dashed ${C.border}`,
          background: 'transparent',
          color: C.textDim,
          borderRadius: 999,
          padding: '3px 10px',
          fontSize: '0.8em',
          cursor: 'pointer',
          font: 'inherit',
          maxWidth: 220,
        },
      },
      LI(
        'span',
        { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        `更多项目 · ${String(options.length)}`,
      ),
      LI('span', { key: 'caret', style: { opacity: 0.6 } }, '▾'),
    ),
    open
      ? LI(
          'div',
          {
            key: 'list',
            role: 'listbox',
            style: {
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 20,
              width: 340,
              maxHeight: 340,
              overflowY: 'auto',
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              // Opaque, not the shell's translucent menu layer: this list opens
              // straight over issue cards, and translucent read as ghost text.
              background: C.pickerList,
              boxShadow: '0 10px 28px rgba(0,0,0,.22)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          LI('input', {
            key: 'search',
            value: needle,
            placeholder: '按项目键或名称筛选…',
            spellCheck: false,
            autoFocus: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setNeedle(event.target.value)
            },
            style: { ...input, fontSize: '0.8em', padding: '4px 8px' },
          }),
          ...shown.map((entry) =>
            LI(
              'button',
              {
                key: entry.key,
                type: 'button',
                role: 'option',
                'aria-selected': entry.key === value,
                'data-project-key': entry.key,
                onClick: () => {
                  onPick(entry.key)
                  setOpen(false)
                },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: 'none',
                  background: entry.key === value ? C.accentSoft : 'transparent',
                  color: entry.key === value ? C.accent : C.text,
                  borderRadius: 7,
                  padding: '5px 8px',
                  fontSize: '0.8em',
                  cursor: 'pointer',
                  font: 'inherit',
                  textAlign: 'left',
                  width: '100%',
                },
              },
              LI('span', { key: 'dot', style: { width: 6, height: 6, flex: 'none', borderRadius: 999, background: projectTone(entry.key) } }),
              LI('span', { key: 'key', style: { flex: 'none', fontWeight: 600 } }, entry.key),
              LI(
                'span',
                {
                  key: 'name',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.textFaint },
                },
                entry.name,
              ),
            ),
          ),
          matches.length === 0
            ? LI('div', { key: 'none', style: { fontSize: '0.78em', color: C.textFaint, padding: '4px 2px' } }, '没有匹配的项目。')
            : null,
          matches.length > MAX_ROWS
            ? LI(
                'div',
                { key: 'more', style: { fontSize: '0.72em', color: C.textFaint, padding: '2px 2px 0' } },
                `还有 ${String(matches.length - MAX_ROWS)} 个，用上面的搜索框收窄`,
              )
            : null,
        )
      : null,
  )
}

/**
 * The sprint catalogue as a searchable picker.
 *
 * A chip per sprint is wrong on a real site: RD003 alone offers 160 of them,
 * with names like "镇海炼化冲刺15.5" that differ by a few characters. So the
 * whole catalogue lives behind one control that filters as you type, and the
 * row shows only the CURRENT selection.
 *
 * Deliberately a listbox built from buttons rather than a native `<select>`:
 * the options carry a state dot and a count, neither of which a `<select>` can
 * render, and the panel's theming would not reach the browser's popup.
 */
function SprintPicker({
  options,
  value,
  loading,
  error,
  project,
  onPick,
}: {
  options: readonly SprintChoice[]
  /** The current selection, in `sprint`-state form (`id:<id>`). */
  value: string
  loading: boolean
  error: string | undefined
  /** The project whose catalogue this is, for the empty state's message. */
  project: string
  /** undefined clears the filter. */
  onPick: (id: string | undefined) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [needle, setNeedle] = React.useState('')
  const box = React.useRef<HTMLDivElement | undefined>(undefined)

  const selectedId = value.startsWith(SPRINT_ID_PREFIX) ? value.slice(SPRINT_ID_PREFIX.length) : undefined
  const selected = selectedId === undefined ? undefined : options.find((entry) => entry.id === selectedId)

  // Close on an outside click and on Escape: a listbox left open over the board
  // covers the very cards it filters.
  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const node = box.current
      if (node !== undefined && event.target instanceof Node && node.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const term = needle.trim().toLowerCase()
  const matches =
    term === ''
      ? options
      : options.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(term))
  // The list is capped so a 160-sprint project does not paint 160 rows: the
  // search box is the way to reach the rest, and the footer says how many are
  // hidden instead of silently truncating.
  const MAX_ROWS = 40
  const shown = matches.slice(0, MAX_ROWS)

  return LI(
    'div',
    { ref: box, 'data-dsh-jira-sprint-picker': '1', style: { position: 'relative', display: 'inline-flex' } },
    LI(
      'button',
      {
        key: 'toggle',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-pressed': selectedId !== undefined,
        title:
          selected === undefined
            ? '按名称选择一个冲刺（服务端筛选）'
            : `${selected.name}（${sprintStateLabel(selected.state)}）—— 服务端筛选：sprint = ${selected.id}`,
        onClick: () => {
          setOpen(!open)
          setNeedle('')
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: `1px solid ${selected === undefined ? C.border : C.accent}`,
          background: selected === undefined ? 'transparent' : C.accentSoft,
          color: selected === undefined ? C.textDim : C.accent,
          borderRadius: 999,
          padding: '3px 10px',
          fontSize: '0.8em',
          fontWeight: selected === undefined ? 400 : 600,
          cursor: 'pointer',
          font: 'inherit',
          maxWidth: 260,
        },
      },
      LI(
        'span',
        {
          key: 'label',
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        },
        selected === undefined
          ? loading
            ? '冲刺…'
            : '具体冲刺'
          : `${sprintStateLabel(selected.state) === '进行中' ? '● ' : ''}${selected.name}`,
      ),
      selected !== undefined
        ? LI(
            'span',
            {
              key: 'clear',
              role: 'presentation',
              title: '清除冲刺筛选',
              onClick: (event: React.MouseEvent) => {
                // The toggle must not also open the list on the way out.
                event.stopPropagation()
                onPick(undefined)
              },
              style: { opacity: 0.7, cursor: 'pointer', paddingLeft: 2 },
            },
            '×',
          )
        : LI('span', { key: 'caret', style: { opacity: 0.6 } }, '▾'),
    ),
    open
      ? LI(
          'div',
          {
            key: 'list',
            role: 'listbox',
            style: {
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 20,
              width: 300,
              maxHeight: 320,
              overflowY: 'auto',
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              // Opaque, not the shell's translucent menu layer: this list opens
              // straight over issue cards, and translucent read as ghost text.
              background: C.pickerList,
              boxShadow: '0 10px 28px rgba(0,0,0,.22)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          LI('input', {
            key: 'search',
            value: needle,
            placeholder: '按名称筛选冲刺…',
            spellCheck: false,
            autoFocus: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setNeedle(event.target.value)
            },
            style: { ...input, fontSize: '0.8em', padding: '4px 8px' },
          }),
          error !== undefined
            ? LI('div', { key: 'err', style: { fontSize: '0.74em', color: TONE_COLOR['bad'] } }, `读取冲刺列表失败：${error}`)
            : null,
          loading
            ? LI('div', { key: 'load', style: { fontSize: '0.78em', color: C.textFaint, padding: '4px 2px' } }, '读取中…')
            : null,
          options.length === 0 && !loading
            ? LI(
                'div',
                { key: 'none', style: { fontSize: '0.78em', color: C.textFaint, padding: '4px 2px' } },
                project === ''
                  ? '当前查询没有确定项目，无法列出冲刺。'
                  : `项目 ${project} 没有可选的冲刺。`,
              )
            : null,
          ...shown.map((entry) =>
            LI(
              'button',
              {
                key: entry.id,
                type: 'button',
                role: 'option',
                'aria-selected': entry.id === selectedId,
                'data-sprint-id': entry.id,
                onClick: () => {
                  onPick(entry.id === selectedId ? undefined : entry.id)
                  setOpen(false)
                },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: 'none',
                  background: entry.id === selectedId ? C.accentSoft : 'transparent',
                  color: entry.id === selectedId ? C.accent : C.text,
                  borderRadius: 7,
                  padding: '5px 8px',
                  fontSize: '0.8em',
                  cursor: 'pointer',
                  font: 'inherit',
                  textAlign: 'left',
                  width: '100%',
                },
              },
              LI('span', {
                key: 'dot',
                style: {
                  width: 6,
                  height: 6,
                  flex: 'none',
                  borderRadius: 999,
                  background:
                    entry.state === 'active'
                      ? TONE_COLOR['ok']
                      : entry.state === 'future'
                        ? TONE_COLOR['pending']
                        : C.textFaint,
                },
              }),
              LI(
                'span',
                {
                  key: 'name',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                entry.name,
              ),
              LI(
                'span',
                { key: 'meta', style: { flex: 'none', fontSize: '0.9em', color: C.textFaint } },
                entry.count > 0 ? `${String(entry.count)} 张` : sprintStateLabel(entry.state),
              ),
            ),
          ),
          matches.length === 0 && options.length > 0
            ? LI('div', { key: 'nomatch', style: { fontSize: '0.78em', color: C.textFaint, padding: '4px 2px' } }, '没有匹配的冲刺。')
            : null,
          matches.length > MAX_ROWS
            ? LI(
                'div',
                { key: 'more', style: { fontSize: '0.72em', color: C.textFaint, padding: '2px 2px 0' } },
                `还有 ${String(matches.length - MAX_ROWS)} 个，用上面的搜索框收窄`,
              )
            : null,
        )
      : null,
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
      // The active sprint, when the issue has one. Only the FIRST entry matters
      // on a card: the card is 276px wide, and the older sprints an issue was
      // carried through are history rather than something to filter by from
      // here — they stay in the drawer.
      sprintBadge(issue) !== undefined
        ? LI(
            Pill as React.ElementType,
            { key: 'sprint', title: sprintBadge(issue)?.title },
            sprintBadge(issue)?.label,
          )
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
  seeded,
  onClose,
  onRefreshBoard,
  onNotify,
}: {
  issue: BoardIssue
  promptTemplate: string
  /**
   * A detail the caller already fetched for this exact issue.
   *
   * A key lookup answers with the same document the drawer reads, so opening
   * the drawer on it must not ask again — and while it exists the drawer has no
   * "读取中…" state to show, because it is already filled in.
   */
  seeded?: DetailPayload | undefined
  onClose: () => void
  onRefreshBoard: () => void
  onNotify: (message: string, tone: 'ok' | 'bad') => void
}): React.ReactElement {
  const services = useHandover()
  const [detail, setDetail] = React.useState<DetailPayload | undefined>(seeded)
  const [transitions, setTransitions] = React.useState<BoardTransition[] | undefined>(undefined)
  const [loading, setLoading] = React.useState(seeded === undefined)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let live = true
    setLoading(seeded === undefined)
    setError(undefined)
    setDetail(seeded)
    setTransitions(undefined)
    const key = encodeURIComponent(issue.key)
    // The description is skipped when the caller already has it: only the
    // transitions still need the server. Both requests otherwise run together,
    // so a slow description must not hold back the transition menu.
    const description: Promise<DetailPayload | undefined> =
      seeded === undefined
        ? api<DetailPayload>(`/issue/${key}`, 'GET')
        : Promise.resolve(undefined)
    Promise.all([
      description,
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
        if (nextDetail !== undefined) setDetail(nextDetail)
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
  }, [issue.key, seeded])

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
  // The drawer is the place the whole picture belongs: every sprint the issue
  // carries, in state order, because a card only has room for the newest one.
  for (const [index, sprint] of (shown.sprints ?? []).entries()) {
    const state = sprint.state === 'active' ? '进行中' : sprint.state === 'future' ? '未开始' : sprint.state === 'closed' ? '已结束' : ''
    metaChips.push(
      LI(
        'span',
        { key: `s${String(index)}`, style: { ...chip, cursor: 'default' } },
        `冲刺 ${sprint.name}${state === '' ? '' : ` · ${state}`}`,
      ),
    )
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

// ---------------------------------------------------------------------------
// Board memory between openings
// ---------------------------------------------------------------------------

/**
 * What the board remembers after the shell unmounts it.
 *
 * The layout mounts exactly one `main` entry at a time (`renderSlot('main', {},
 * { entryKey })`), so selecting another panel or opening Settings tears this
 * component down and its React state is gone. Without something outside the
 * component every reopening is an empty board plus a Jira round-trip — the
 * panel "reloads" for no reason the user can see. The snapshot keeps the
 * payload and the view that was on screen, so opening it again is a paint.
 *
 * Deliberately module-scoped rather than persisted: it dies with the page, so a
 * reload always starts from the host instead of a stale file. It holds no token
 * and no prompt, only what the board was showing.
 */
interface BoardSnapshot {
  /** The payload the last successful read returned. */
  board?: BoardPayload
  /** When that read landed, for the freshness window. */
  updatedAt?: number
  /** The JQL that payload answers, so another query cannot reuse it. */
  jql: string
  /** The deployment's pinned query at capture time, to notice a config edit. */
  configJql: string
  viewId: string
  override?: string
  project: string
  category: string
  /** The sprint filter, as `sprintClauseOf` understands it. */
  sprint: string
  mine: boolean
  query: string
  /** The full project catalogue at capture time, so a reopen need not refetch. */
  projects?: readonly BoardProject[]
  /** When that catalogue landed. */
  projectsAt?: number
}

/**
 * How long a restored project catalogue is trusted without asking the host.
 *
 * A project list changes when somebody creates one, not minute to minute — an
 * hour of reuse is exactly the "初始化读取后不再重载" behaviour. The explicit
 * 刷新 button still re-reads immediately.
 */
const PROJECT_CACHE_TTL = 3_600_000

/** How long a restored board is trusted without asking the host again. */
const BOARD_CACHE_TTL = 60_000

/** Whether a snapshot carries a project catalogue still worth painting. */
function canReuseProjects(snapshot: BoardSnapshot | undefined, now: number): boolean {
  const at = snapshot?.projectsAt
  return snapshot?.projects !== undefined && at !== undefined && now - at < PROJECT_CACHE_TTL
}

let boardSnapshot: BoardSnapshot | undefined

function blankSnapshot(): BoardSnapshot {
  return {
    jql: '',
    configJql: '',
    viewId: VIEWS[0].id,
    // '' means "no project chosen yet", which is the moment before `GET
    // /projects` answers. The panel never asks for a board until it is set.
    project: '',
    category: 'all',
    sprint: SPRINT_ALL,
    mine: false,
    query: '',
  }
}

function readBoardSnapshot(): BoardSnapshot | undefined {
  return boardSnapshot
}

/** Merge a change into the snapshot: it is one object, not an event log. */
function writeBoardSnapshot(patch: Partial<BoardSnapshot>): void {
  boardSnapshot = { ...(boardSnapshot ?? blankSnapshot()), ...patch }
}

/**
 * Whether the snapshot holds this query's payload, fresh or not.
 *
 * The freshness half is `canReuseBoard`'s: a matching but old snapshot is
 * painted and revalidated in the background instead of being thrown away.
 */
function snapshotAnswers(snapshot: BoardSnapshot | undefined, jql: string): boolean {
  return snapshot !== undefined && snapshot.board !== undefined && snapshot.jql === jql
}

/**
 * Whether a snapshot may be painted as-is instead of triggering a read.
 *
 * A cached board is reusable when it ANSWERS THIS QUERY and is younger than one
 * poll period; anything else is a board the panel would have to replace the
 * moment it appeared, which is the reload this avoids.
 */
function canReuseBoard(snapshot: BoardSnapshot | undefined, jql: string, now: number): boolean {
  if (snapshot === undefined || !snapshotAnswers(snapshot, jql)) return false
  const at = snapshot.updatedAt
  return at !== undefined && now - at < BOARD_CACHE_TTL
}

/**
 * What opening the panel should do with the snapshot.
 *
 * - `paint`      — show it and ask the host nothing; the next poll would return
 *                  this same answer.
 * - `revalidate` — show it, then ask in the background: old, but still the
 *                  answer to this query, so blanking for it would be a lie.
 * - `read`       — nothing worth showing; the panel has to wait for the host.
 *
 * Pure, and exported so the regression harness can pin all three outcomes; that
 * mapping is the whole "it does not reload every time" behaviour.
 */
type Opening = 'paint' | 'revalidate' | 'read'

function openingPlan(snapshot: BoardSnapshot | undefined, jql: string, now: number): Opening {
  if (canReuseBoard(snapshot, jql, now)) return 'paint'
  return snapshotAnswers(snapshot, jql) ? 'revalidate' : 'read'
}

/**
 * The query a view id plus the server-side selections produces.
 *
 * Order matters only in that every fold inserts before a trailing `ORDER BY`.
 * The project comes FIRST: it is the board's scope, so it must be in force
 * before the other constraints are folded into the same query. The sprint
 * clause is added last so a hand-written query's own sprint constraint still
 * wins the `sprintFilterOf` read-back.
 */
function jqlForView(
  viewId: string,
  override: string | undefined,
  project: string,
  mine: boolean,
  sprint = SPRINT_ALL,
): string {
  const view = VIEWS.find((entry) => entry.id === viewId) ?? VIEWS[0]
  return withSprint(withMine(withProject(override ?? view.jql, project), mine), sprint)
}

/**
 * The board panel: the keyed `main` cell addressed by the sidebar icon.
 *
 * A project is always selected: the row offers every project the authorization
 * can see and no "全部" entry, because the scope has to be one project for the
 * issue count beside it to mean anything, and because "all projects" was
 * exactly the query whose first page hid the project the user was looking for.
 *
 * Filtering by STATUS and by search text stays CLIENT-side: the whole project is
 * already in hand, so refining it is instant and costs no round-trips. The
 * project, the sprint and "assigned to me" are SERVER-side, because each one
 * changes WHICH issues are read.
 */
function JiraBoardPanel(): React.ReactElement {
  const services = useHandover()
  const { payload: status } = useStatus()
  const panel = usePanelPrefs()
  const promptTemplate = status?.board.promptTemplate ?? ''
  const configJql = status?.board.jql ?? ''
  /** The host has answered, so `configJql` is a real value rather than ''. */
  const hostReady = status !== undefined

  // What the previous opening left behind. Read once: it is the starting
  // paint, not something this render keeps following.
  const snapshot = React.useMemo(readBoardSnapshot, [])
  const restored =
    snapshot === undefined ||
    snapshot.jql !== jqlForView(snapshot.viewId, snapshot.override, snapshot.project, snapshot.mine, snapshot.sprint)
      ? undefined
      : snapshot

  const [board, setBoard] = React.useState<BoardPayload | undefined>(restored?.board)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [loading, setLoading] = React.useState(restored?.board === undefined)
  const [override, setOverride] = React.useState<string | undefined>(restored?.override)
  /** What the JQL box shows while it is being edited. */
  const [jqlDraft, setJqlDraft] = React.useState('')
  const [editingJql, setEditingJql] = React.useState(false)
  const [viewId, setViewId] = React.useState<string>(restored?.viewId ?? VIEWS[0].id)
  /**
   * The selected project key. NEVER `'all'`: the board always reads exactly one
   * project, so the count beside the chip is that project's count rather than
   * the first page of a site-wide query. Empty means "not chosen yet", which
   * only happens for the moment before the project list arrives.
   */
  const [project, setProject] = React.useState<string>(
    // `'all'` was the old "no project selected" sentinel; a restored snapshot
    // from before this change carries it, so it is read as "not chosen yet".
    restored?.project === undefined || restored.project === 'all' ? '' : restored.project,
  )
  /** Every project the authorization can see, for the row. */
  const [projectList, setProjectList] = React.useState<readonly BoardProject[]>([])
  const [projectListError, setProjectListError] = React.useState<string | undefined>(undefined)
  const [category, setCategory] = React.useState<string>(restored?.category ?? 'all')
  /** Sprint filter: a SERVER-side constraint, like "assigned to me". */
  const [sprint, setSprint] = React.useState(restored?.sprint ?? SPRINT_ALL)
  /** "Assigned to me": a SERVER-side constraint, not a client-side chip. */
  const [mine, setMine] = React.useState(restored?.mine ?? false)
  const [query, setQuery] = React.useState(restored?.query ?? '')
  const [selected, setSelected] = React.useState<string | undefined>(undefined)
  /** Multi-selection, by issue key. Empty means "no selection mode". */
  const [checked, setChecked] = React.useState<readonly string[]>([])
  /** Where the multi-selection was last anchored, for shift-click ranges. */
  const anchor = React.useRef<string | undefined>(undefined)
  const [menu, setMenu] = React.useState<{ x: number; y: number; keys: readonly string[] } | undefined>(undefined)
  const [dragging, setDragging] = React.useState<string | undefined>(undefined)
  const [notice, setNotice] = React.useState<{ message: string; tone: 'ok' | 'bad' } | undefined>(undefined)
  const [updatedAt, setUpdatedAt] = React.useState<number | undefined>(restored?.updatedAt)
  /**
   * An issue fetched by key, because the loaded page cannot contain it.
   *
   * The drawer opens on a lookup, and its own `GET /issue/<key>` would be a
   * second read of the same document the lookup just fetched — so the detail
   * comes back with it, and the drawer starts already filled in.
   */
  const [resolved, setResolved] = React.useState<{ issue: BoardIssue; description: string } | undefined>(undefined)
  /** Whether a key lookup is in flight, so the box can say so. */
  const [resolving, setResolving] = React.useState(false)
  const resolvedFor = React.useRef<string | undefined>(undefined)
  const mounted = React.useRef(true)
  const sequence = React.useRef(0)
  /** The configured JQL has been installed once, and only once. */
  const seeded = React.useRef(false)
  /** The opening decision is made; later runs are real query changes. */
  const opened = React.useRef(false)
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
  //
  // A restored snapshot supersedes both: it already carries the view the user
  // was reading. The one thing it must not do is outlive an edit to the pinned
  // query, so a changed `board.jql` drops it and starts from the config.
  React.useEffect(() => {
    if (seeded.current || status === undefined) return
    seeded.current = true
    if (snapshot !== undefined && snapshot.configJql !== configJql) {
      writeBoardSnapshot({ ...blankSnapshot(), configJql })
      setBoard(undefined)
      setUpdatedAt(undefined)
      setOverride(configJql.trim() === '' ? undefined : configJql)
      setViewId(configJql.trim() === '' ? VIEWS[0].id : 'all')
      return
    }
    if (restored !== undefined) return
    if (configJql.trim() !== '') {
      setOverride(configJql)
      setViewId('all')
    }
  }, [status, configJql, snapshot, restored])

  const activeView = VIEWS.find((view) => view.id === viewId) ?? VIEWS[0]
  const effectiveJql = React.useMemo(
    () => withSprint(withMine(withProject(override ?? activeView.jql, project), mine), sprint),
    [override, activeView, project, mine, sprint],
  )

  React.useEffect(() => {
    if (!editingJql) setJqlDraft(effectiveJql)
  }, [effectiveJql, editingJql])

  /**
   * Read the board.
   *
   * `quiet` is the revalidation path: a restored board stays on screen while a
   * newer one is fetched, so a reopen never blanks and never shows a spinner
   * for data that is already legible. A visible read (first open, project or
   * view change, the poll, the Refresh button) still sets `loading`.
   *
   * A read is REFUSED while no project is selected. The project is the board's
   * scope, and fetching the un-scoped query would answer with a site-wide page
   * that the panel then has to filter — exactly the behaviour that hid a project
   * behind whichever issues happened to sort first.
   */
  const refresh = React.useCallback(
    async (options?: { quiet?: boolean }): Promise<void> => {
      if (project.trim() === '') {
        setLoading(false)
        return
      }
      const quiet = options?.quiet === true
      const ticket = (sequence.current += 1)
      if (!quiet) setLoading(true)
      try {
        const suffix = effectiveJql.trim() === '' ? '' : `?jql=${encodeURIComponent(effectiveJql)}`
        const next = await api<BoardPayload>(`/board${suffix}`, 'GET')
        // Only the newest request may write state: a slow early response must
        // not overwrite a newer one.
        if (mounted.current && ticket === sequence.current) {
          const at = Date.now()
          setBoard(next)
          setError(undefined)
          setUpdatedAt(at)
          // The snapshot is what a later opening paints, so it is stored
          // together with the query it answers: a payload and its JQL are one
          // fact, and mixing them up would show the wrong board.
          writeBoardSnapshot({ board: next, updatedAt: at, jql: effectiveJql })
        }
      } catch (reason) {
        if (mounted.current && ticket === sequence.current) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        if (mounted.current && ticket === sequence.current) setLoading(false)
      }
    },
    [effectiveJql, project],
  )

  // The project row is the board's SCOPE selector, so it is read from the site
  // itself — `GET /projects` pages to exhaustion — rather than derived from
  // whatever the last query happened to return. Deriving it was what made a
  // project the user works in every day simply absent from the row.
  //
  // Read once per opening and re-read only on an explicit refresh: a project
  // list changes when somebody creates a project, not between polls.
  //
  // The preferences are read through a REF rather than a dependency: opening a
  // project writes to `recentProjects`, and depending on that would re-enter
  // this callback on every click and re-fetch the whole catalogue each time.
  const prefsRef = React.useRef(panel.value)
  prefsRef.current = panel.value

  const projectEpoch = React.useRef(0)
  const loadProjects = React.useCallback(async (): Promise<void> => {
    if (!hostReady) return
    const ticket = (projectEpoch.current += 1)
    try {
      const response = await api<{ ok: boolean; projects: BoardProject[] }>('/projects', 'GET')
      if (!mounted.current || ticket !== projectEpoch.current) return
      const list = (response.projects ?? []).filter((entry) => typeof entry?.key === 'string')
      setProjectList(list)
      setProjectListError(undefined)
      // Cache it like the board payload: a reopen paints this instead of
      // flashing "读取项目…" again, until the TTL or an explicit refresh says so.
      writeBoardSnapshot({ projects: list, projectsAt: Date.now() })
      // The first answer also picks the scope. The order is "strongest statement
      // of intent first": the query the deployment pinned, then the last project
      // this person actually opened, then a pin, then the site's own first entry.
      // Recency beats a pin here because a pin is "keep this handy", while the
      // recent list is "this is what I was doing".
      setProject((current) => {
        if (current !== '' && list.some((entry) => entry.key === current)) return current
        const inList = (key: string | undefined): boolean =>
          key !== undefined && list.some((entry) => entry.key === key)
        const pinnedInConfig = PROJECT_EQUALS_PATTERN.exec(configJql)?.[1]?.toUpperCase()
        if (inList(pinnedInConfig)) return pinnedInConfig as string
        const recent = prefsRef.current.recentProjects.find(inList)
        if (recent !== undefined) return recent
        const pinned = prefsRef.current.pinnedProjects.find(inList)
        return pinned ?? list[0]?.key ?? ''
      })
    } catch (reason) {
      if (!mounted.current || ticket !== projectEpoch.current) return
      setProjectListError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [hostReady, configJql])

  React.useEffect(() => {
    // A reopen paints the cached catalogue — the same contract the board payload
    // keeps, so the row does not blank into "读取项目…" on every opening. Inside
    // the TTL the host is asked NOTHING; past it, what is cached still paints
    // while a quiet revalidation runs underneath.
    const snapshot = readBoardSnapshot()
    if (snapshot?.projects !== undefined) {
      setProjectList([...snapshot.projects])
      if (canReuseProjects(snapshot, Date.now())) return
    }
    void loadProjects()
  }, [loadProjects])

  /**
   * Open one project and remember it as the most recent.
   *
   * The recency write is fire-and-forget: a failed preference write must not
   * stop the board from switching, and the in-memory publish already happened so
   * the row reorders immediately either way.
   */
  const openProject = React.useCallback((key: string): void => {
    setProject(key)
    const next = pushRecent(prefsRef.current.recentProjects, key)
    publishPanelPrefs({ ...prefsRef.current, recentProjects: next }, true)
    void saveRecentProjects(next).catch(() => undefined)
  }, [])

  // Opening the panel: paint what is remembered, then decide whether the host
  // is worth asking. A snapshot younger than one poll period holds exactly what
  // the next tick would return, so reopening inside that window costs no
  // request at all; older than that, it stays on screen while it revalidates.
  React.useEffect(() => {
    if (project.trim() === '') return
    if (!opened.current) {
      opened.current = true
      const plan = openingPlan(snapshot, effectiveJql, Date.now())
      if (plan === 'paint') return
      if (plan === 'revalidate') {
        void refresh({ quiet: true })
        return
      }
    }
    void refresh()
  }, [refresh, effectiveJql, project, snapshot])

  // The filters are client-side, so they change without a fetch. Mirroring them
  // into the snapshot is what makes a reopen land on the same slice of the
  // board instead of back at "everything". `sprint` is in here even though it
  // is server-side: it is still part of what the user was looking at.
  React.useEffect(() => {
    writeBoardSnapshot({ viewId, override, project, category, sprint, mine, query })
  }, [viewId, override, project, category, sprint, mine, query])

  // The pinned query is only meaningful once the host has answered; writing its
  // '' placeholder first would look like a config change on the next opening.
  React.useEffect(() => {
    if (!hostReady) return
    writeBoardSnapshot({ configJql })
  }, [configJql, hostReady])

  // A board painted from the snapshot must not outlive the account it came
  // from: `idle` means there is no account at all, and a different or
  // mismatched site is a board belonging to somebody else's Jira. Either way
  // the panel returns to the connect prompt instead of vouching for numbers it
  // cannot stand behind. Transitional and `error` states keep their board — the
  // badge is the honest signal there, and wiping would also lose a usable view.
  React.useEffect(() => {
    if (status === undefined || board === undefined) return
    const signedOut = status.status === 'idle'
    const otherSite =
      status.siteMismatch || (status.site !== undefined && board.site !== undefined && status.site !== board.site)
    if (!signedOut && !otherSite) return
    setBoard(undefined)
    setUpdatedAt(undefined)
    writeBoardSnapshot({ board: undefined, updatedAt: undefined })
  }, [status, board])

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

  const loaded = React.useMemo(() => board?.issues ?? [], [board])

  /**
   * The issue a key lookup brought in, when the page cannot contain it.
   *
   * Folded into `issues` below so everything downstream — the status columns,
   * the project chips, the selection and the hand-over — treats it like any
   * other card. Keeping it in a parallel list would have made "open the drawer"
   * work while every action on that issue silently did nothing.
   */
  const pinned =
    resolved !== undefined && !loaded.some((issue) => issue.key === resolved.issue.key) ? resolved.issue : undefined

  const issues = React.useMemo(
    () => (pinned === undefined ? loaded : [pinned, ...loaded]),
    [loaded, pinned],
  )

  /**
   * The detail the lookup already fetched, handed to the drawer it opens.
   *
   * `/issue/<key>` is exactly what the drawer would ask for, so without this the
   * one gesture "look this key up" would cost two identical reads and the drawer
   * would still show "读取中…" after the card was already on screen.
   */
  const seededDetail = React.useMemo<DetailPayload | undefined>(
    () =>
      resolved === undefined
        ? undefined
        : { ok: true, issue: resolved.issue, description: resolved.description },
    [resolved],
  )

  /**
   * The projects the ROW shows: pinned, recent, and the current one.
   *
   * The site lists 148 projects, so a chip per project is not a row — it is a
   * wall nobody can scan. Jira's own sidebar solves this the same way: a short
   * "recent" strip plus a way to search the rest. So the row holds
   *
   *   1. every PINNED project, in pin order (deliberate intent outranks history),
   *   2. then the recently-opened projects, newest first,
   *   3. plus the current selection, which must be visible even when it is
   *      neither pinned nor recent (it was just picked from the catalogue).
   *
   * Everything else is reachable through the "更多项目" picker beside the row,
   * which searches the complete list. Only the SELECTED chip carries a count: it
   * is the one project whose whole issue set the board has actually read.
   */
  const pinnedProjects = panel.value.pinnedProjects
  const recentProjects = panel.value.recentProjects

  const byKey = React.useMemo(() => {
    const map = new Map<string, BoardProject>()
    for (const entry of projectList) map.set(entry.key, entry)
    return map
  }, [projectList])

  /** The keys the row shows, in row order, deduplicated. */
  const rowKeys = React.useMemo(() => {
    const keys: string[] = []
    const push = (key: string): void => {
      if (key !== '' && !keys.includes(key)) keys.push(key)
    }
    for (const key of pinnedProjects) push(key)
    for (const key of recentProjects) push(key)
    push(project)
    return keys
  }, [pinnedProjects, recentProjects, project])

  /** The row's entries. A project the site no longer lists is still shown by
   *  key — a pin or a recent entry is the user's own record, and hiding it
   *  because the list was read a moment earlier would silently drop a choice. */
  const projects = React.useMemo(
    () => rowKeys.map((key) => byKey.get(key) ?? { key, name: key, updated: undefined }),
    [rowKeys, byKey],
  )

  /**
   * Which project's sprint catalogue to list.
   *
   * Always the selected project: the board reads exactly one, so its sprint
   * catalogue is the one the row can offer. `project` is never `'all'`, which is
   * what makes this a straight read instead of a guess.
   */
  const sprintProject = project

  /** The sprint catalogue for {@link sprintProject}, loaded per project. */
  const [sprintCatalogue, setSprintCatalogue] = React.useState<SprintOption[]>([])
  const [sprintLoading, setSprintLoading] = React.useState(false)
  const [sprintError, setSprintError] = React.useState<string | undefined>(undefined)
  const sprintEpoch = React.useRef(0)

  React.useEffect(() => {
    if (!hostReady || sprintProject === '') {
      setSprintCatalogue([])
      setSprintError(undefined)
      return
    }
    const ticket = (sprintEpoch.current += 1)
    setSprintLoading(true)
    setSprintError(undefined)
    void (async () => {
      try {
        const response = await api<{ ok: boolean; sprints: SprintOption[] }>(
          `/sprints?project=${encodeURIComponent(sprintProject)}`,
          'GET',
        )
        if (!mounted.current || ticket !== sprintEpoch.current) return
        setSprintCatalogue(response.sprints ?? [])
      } catch (reason) {
        if (!mounted.current || ticket !== sprintEpoch.current) return
        // An empty catalogue is not fatal: the page's own sprints still become
        // chips (see `sprintChoices`), so the filter stays usable and the error
        // is a hint rather than a wall.
        setSprintCatalogue([])
        setSprintError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (mounted.current && ticket === sprintEpoch.current) setSprintLoading(false)
      }
    })()
  }, [sprintProject, hostReady])

  /** The catalogue merged with the page, counts included. */
  const sprints = React.useMemo(() => sprintChoices(sprintCatalogue, issues), [sprintCatalogue, issues])

  const categories = React.useMemo(() => categoryChoices(issues), [issues])

  const visible = React.useMemo(() => {
    // A by-key lookup IS the answer: the board shows that one issue, without
    // asking the chips to explain a card the loaded page never had. The page
    // comes back the moment the lookup is put away.
    if (pinned !== undefined) return [pinned]
    const needle = query.trim().toLowerCase()
    // The project is NOT filtered here: it is already the JQL's scope, so every
    // issue in hand belongs to it. Re-filtering would only matter if the server
    // had answered with another project's issues, which would be a bug worth
    // seeing rather than hiding behind a client-side sweep.
    return issues.filter((issue) => {
      if (category !== 'all' && issue.status.categoryKey !== category) return false
      if (needle !== '') {
        const haystack = `${issue.key} ${issue.summary} ${issue.projectName ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [issues, pinned, category, query])

  const columns = React.useMemo(() => groupColumns(visible), [visible])

  /**
   * Answer a search for one exact issue.
   *
   * Called when the search box holds a bare key or a Jira link. The issue is
   * fetched by key, so it is found regardless of whether the current page (or
   * the current filters) happens to contain it, and the drawer opens on it. A
   * failure is reported in the notice rather than as the board's error, because
   * the board itself is still perfectly readable.
   */
  const openKey = React.useCallback(
    async (key: string): Promise<void> => {
      // Already on the board: no request, just show it.
      const held = issues.find((issue) => issue.key === key)
      if (held !== undefined) {
        setSelected(held.key)
        return
      }
      // Already looked up: reopening the drawer costs no round-trip, which is
      // what makes pressing Enter twice on the same key harmless.
      if (resolvedFor.current === key) {
        setSelected(key)
        return
      }
      resolvedFor.current = key
      setResolving(true)
      try {
        const detail = await api<DetailPayload>(`/issue/${encodeURIComponent(key)}`, 'GET')
        if (!mounted.current) return
        // A host that answers without an issue has answered nothing usable:
        // accepting it would leave `resolved` set with no key, and the render
        // that reads it would throw instead of reporting the failure.
        if (detail.issue === undefined || detail.issue.key === undefined) {
          resolvedFor.current = undefined
          notify(`找不到 ${key}：服务端没有返回工单内容`, 'bad')
          return
        }
        setResolved({ issue: detail.issue, description: detail.description ?? '' })
        setSelected(detail.issue.key)
        setError(undefined)
      } catch (reason) {
        if (!mounted.current) return
        // Let the same key be retried once the user knows why it failed.
        resolvedFor.current = undefined
        notify(`找不到 ${key}：${reason instanceof Error ? reason.message : String(reason)}`, 'bad')
      } finally {
        if (mounted.current) setResolving(false)
      }
    },
    [issues, notify],
  )

  /**
   * Escape, and a cleared search box, drop a by-key lookup.
   *
   * The resolved issue is not in the board's page, so keeping its drawer open
   * after the search that produced it is gone would leave the board showing an
   * issue no filter on screen explains.
   */
  const clearSearch = React.useCallback((): void => {
    setQuery('')
    setResolved(undefined)
    resolvedFor.current = undefined
  }, [])

  /**
   * Re-derive the board's one issue from a remembered search box, once.
   *
   * A snapshot carries the box text, not the issue, so a repaint cannot show a
   * by-key result the page itself does not hold. Re-running the lookup is what
   * makes a reopened board land where the user left off; it costs one request
   * and only when the remembered text is a key or a link. Runs after `openKey`
   * exists, which is why it sits here rather than beside the opening effect.
   */
  const restoredSearch = React.useRef(false)
  React.useEffect(() => {
    if (restoredSearch.current) return
    restoredSearch.current = true
    const remembered = snapshot?.query.trim() ?? ''
    if (remembered === '') return
    const key = issueKeyOf(remembered)
    if (key === undefined) return
    // Nothing local can satisfy a key the page does not hold: ask the server.
    resolvedFor.current = undefined
    void openKey(key)
  }, [snapshot, openKey])

  const selectedIssue = issues.find((issue) => issue.key === selected)
  const checkedIssues = React.useMemo(
    () => visible.filter((issue) => checked.includes(issue.key)),
    [visible, checked],
  )
  const connected = status?.status === 'ready'
  /**
   * Whether anything narrows the board BEYOND its project.
   *
   * The project is not counted: it is the board's scope, always set, so treating
   * it as a filter would leave "清除筛选" permanently on screen with nothing it
   * could sensibly clear. The sprint and "assigned to me" chips do count, even
   * though they work through the JQL: they are filters the user turned on, and
   * the button has to be able to turn them off.
   */
  const filtering = category !== 'all' || query.trim() !== '' || mine || sprint !== SPRINT_ALL

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
    // A transient failure must not throw away a board that is still on screen:
    // with a payload in hand the header carries the warning instead of the
    // whole panel collapsing into an error page.
    if (error !== undefined && board === undefined) {
      return LI(
        'div',
        { key: 'error', style: { ...box, margin: 0, maxWidth: 560, borderColor: TONE_COLOR['bad'] } },
        LI('div', { key: 'title', style: { color: TONE_COLOR['bad'], fontSize: '0.9em', marginBottom: 6 } }, '读取失败'),
        LI('div', { key: 'body', style: { fontSize: '0.85em', whiteSpace: 'pre-wrap', opacity: 0.9 } }, error),
      )
    }
    if (columns.length === 0) {
      // The search box holds a key or a link, but nothing has resolved it. Ask
      // for one click instead of claiming the issue does not exist: "no cards
      // on this page" and "no such issue" are different answers.
      const pendingKey = issueKeyOf(query)
      if (pendingKey !== undefined && resolved?.issue.key !== pendingKey) {
        return LI(
          'div',
          { key: 'direct', style: { ...box, margin: 0, maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 8 } },
          LI(
            'div',
            { key: 'text', style: { fontSize: '0.88em' } },
            resolving ? `正在查找 ${pendingKey}…` : `${pendingKey} 不在当前这一页（或不在当前筛选里）。`,
          ),
          LI(
            'button',
            {
              key: 'go',
              type: 'button',
              disabled: resolving,
              style: { ...chip, borderColor: C.accent, color: C.accent, alignSelf: 'flex-start', opacity: resolving ? 0.5 : 1 },
              onClick: () => {
                void openKey(pendingKey)
              },
            },
            resolving ? '查找中…' : `按编号打开 ${pendingKey}`,
          ),
          LI('div', { key: 'hint', style: { fontSize: '0.76em', color: C.textFaint } }, '也可以直接回车；查找不受当前视图和每页上限限制。'),
        )
      }
      return LI(
        'div',
        { key: 'empty', style: { ...box, margin: 0, maxWidth: 560 } },
        loading
          ? '读取中…'
          : project === ''
            ? '正在读取项目列表…'
            : filtering
              ? `项目 ${project} 在当前筛选下没有工单。放宽状态或经办人，或清空搜索框。`
              : `项目 ${project} 在这个视图下没有工单。切到“全部”视图，或在 JQL 里放宽时间范围。`,
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
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 2, paddingBottom: 7, borderBottom: `1px solid ${C.borderSoft}` } },
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
            'data-dsh-jira-cards': '1',
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
      // The identity block doubles as the refresh control: it sits in the one
      // corner that never moves, so a click re-reads the board even when the
      // toolbar has wrapped or scrolled out of reach. `aria-pressed` is absent
      // on purpose — the stylesheet only adds a hover fill to plain buttons.
      LI(
        'button',
        {
          key: 'identity',
          type: 'button',
          'data-dsh-jira-refresh': '1',
          title: '点击刷新看板',
          'aria-label': '刷新 Jira 看板',
          disabled: loading,
          onClick: () => void refresh(),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 0,
            padding: '6px 10px',
            margin: '-6px -10px',
            border: 'none',
            borderRadius: 10,
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            font: 'inherit',
            cursor: loading ? 'default' : 'pointer',
          },
        },
        LI(Mark, { key: 'mark' }),
        // Phrasing content only: a button may not hold block elements.
        LI(
          'span',
          { key: 'titles', style: { display: 'block', minWidth: 0 } },
          LI('span', { key: 'name', style: { display: 'block', fontSize: '1.05em', fontWeight: 600 } }, 'Jira 看板'),
          LI(
            'span',
            { key: 'sub', style: { display: 'block', fontSize: '0.78em', color: C.textFaint } },
            board?.site ?? status?.site ?? 'Atlassian',
            updatedAt === undefined ? '' : ` · 更新于 ${new Date(updatedAt).toLocaleTimeString()}`,
            // The click has to look like it did something; the toolbar's own
            // "刷新中…" may be off screen, and this block is where it was asked
            // for.
            loading ? ' · 刷新中…' : '',
            // Silence would imply the numbers are current; a failed sync says so
            // without replacing the board that is still readable.
            error === undefined
              ? ''
              : LI('span', { key: 'stale', title: error, style: { color: TONE_COLOR['bad'] } }, ' · 同步失败'),
          ),
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
    // the same way.
    //
    // There is deliberately NO "全部" chip: the board reads exactly one project,
    // so it always has a scope, and the count beside the active chip is that
    // project's count. Clicking the active project again is a no-op rather than
    // a way back to "everything" — "everything" was the query whose first screen
    // hid the project the user was looking for.
    LI(
      'div',
      { key: 'filters', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      LI(
        'div',
        {
          key: 'projects',
          'data-dsh-jira-projects': '1',
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
        },
        LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30 } }, '项目'),
        projectListError === undefined
          ? null
          : LI(
              'span',
              {
                key: 'project-error',
                title: projectListError,
                style: { fontSize: '0.74em', color: TONE_COLOR['bad'] },
              },
              '项目列表读取失败',
            ),
        // Pinned first, then the recently-opened strip, then the current
        // selection: see `rowKeys`. Everything else is in the picker beside the
        // row, because 148 chips is not a row.
        projects.map((entry) =>
          LI(FilterChip, {
            key: entry.key,
            active: project === entry.key,
            label: entry.key,
            // Only the selected project can promise a count: it is the one whose
            // whole issue set the board has actually read.
            count: project === entry.key ? issues.length : undefined,
            tone: projectTone(entry.key),
            title: entry.name,
            pinned: pinnedProjects.includes(entry.key),
            onPin: () => {
              void savePinnedProjects(togglePinned(panel.value.pinnedProjects, entry.key))
            },
            onClick: () => {
              openProject(entry.key)
            },
          }),
        ),
        projectList.length > 0
          ? LI(ProjectPicker, {
              key: 'picker',
              options: projectList,
              value: project,
              onPick: openProject,
            })
          : null,
        projectList.length === 0 && projectListError === undefined
          ? LI('span', { key: 'loading', style: { fontSize: '0.74em', color: C.textFaint } }, '读取项目…')
          : null,
      ),
      // Sprint is SERVER-side, like "assigned to me": a sprint whose issues sit
      // on another page must not read as an empty sprint. No coarse chips — the
      // user asked for named sprints only, and "镇海炼化冲刺15.5" is the option
      // they actually reach for — just the project's whole sprint catalogue as a
      // searchable picker.
      LI(
        'div',
        {
          key: 'sprints',
          'data-dsh-jira-sprints': '1',
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
        },
        LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30 } }, '冲刺'),
        // The catalogue itself, as a searchable picker rather than a chip per
        // sprint: 160 chips would bury the board, and the user knows the name
        // they want ("镇海炼化冲刺15.5").
        LI(SprintPicker, {
          key: 'picker',
          options: sprints,
          value: sprint,
          loading: sprintLoading,
          error: sprintError,
          project: sprintProject,
          onPick: (id: string | undefined) => {
            setSprint(id === undefined ? SPRINT_ALL : `${SPRINT_ID_PREFIX}${id}`)
          },
        }),
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
      LI(
        'div',
        { key: 'assignee', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        LI('span', { key: 'label', style: { fontSize: '0.74em', color: C.textFaint, minWidth: 30 } }, '经办人'),
        // No count, deliberately. This chip changes the JQL, so a truthful count
        // would need a second round-trip to the server; a count taken from the
        // loaded page would be exactly the number the chip already shows when
        // active, and a wrong number in a filter chip is worse than none.
        LI(FilterChip, {
          key: 'mine',
          active: mine,
          label: '我',
          title: `${MINE_CLAUSE} —— 只看指派给我的工单（服务端筛选）`,
          onClick: () => {
            setMine(!mine)
          },
        }),
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
      // Two behaviours in one box, on purpose. While typing it narrows the page
      // already loaded (instant, no request); pressing Enter on a bare key or a
      // pasted Jira link asks the SERVER for exactly that issue, so a key from
      // another page or another view is still found instead of reading as
      // "没有工单". The title says which is which.
      LI('input', {
        key: 'search',
        value: query,
        placeholder: '搜索编号或标题… 回车直达',
        spellCheck: false,
        title: '输入即在本页过滤；输入 HMHP-111 或 Jira 链接后回车，按编号精确查找（不受当前页和筛选限制）',
        'aria-busy': resolving,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const value = event.target.value
          setQuery(value)
          // A by-key result belongs to the search that produced it: as soon as
          // the box no longer names that key, its drawer is closed.
          if (resolved !== undefined && issueKeyOf(value) !== resolved.issue.key) setResolved(undefined)
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Escape') {
            if (query.trim() === '' && resolved === undefined) return
            event.preventDefault()
            clearSearch()
            return
          }
          if (event.key !== 'Enter') return
          const key = issueKeyOf(query)
          if (key === undefined) return
          event.preventDefault()
          void openKey(key)
        },
        style: { ...input, flex: '1 1 180px', maxWidth: 280 },
      }),
      // Says out loud that Enter will look the key up on the server, rather than
      // letting an empty board imply the issue does not exist.
      issueKeyOf(query) !== undefined
        ? LI('span', { key: 'direct', style: { fontSize: '0.74em', color: C.textFaint } }, resolving ? '查找中…' : '回车按编号查找')
        : null,
      filtering
        ? LI(
            'button',
            {
              key: 'clear',
              type: 'button',
              style: chip,
              title: '清空状态、冲刺、经办人与搜索条件（项目是看板范围，不会被清掉）',
              onClick: () => {
                setCategory('all')
                setSprint(SPRINT_ALL)
                setMine(false)
                clearSearch()
              },
            },
            '清除筛选',
          )
        : null,
      LI('span', { key: 'spacer', style: { flex: 1 } }),
      LI(
        'button',
        {
          key: 'refresh',
          type: 'button',
          style: chip,
          disabled: loading,
          title: '重新读取项目列表与当前项目的工单',
          onClick: () => {
            // The project list is re-read here too: a project somebody created
            // since the panel opened has to become selectable without a reload.
            void loadProjects()
            void refresh()
          },
        },
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
          const text = jqlDraft
          setOverride(text)
          setEditingJql(false)
          // The chips have to mirror what was just committed. Once a
          // hand-written query is the override, the clauses inside it survive a
          // chip being switched off — so a query that pins the assignee IS the
          // "assigned to me" state, one that names a sprint IS that sprint
          // filter, and one that names a project IS the selected project.
          // Without this the chips could read "全部" while the board stayed
          // filtered. A set-shaped project restriction (`project in (...)`)
          // deliberately leaves the project chip alone: no single chip can
          // represent it, and the JQL row is where that query stays visible.
          setMine(MINE_PATTERN.test(text))
          setSprint(sprintFilterOf(text))
          const projectKey = projectFilterOf(text)
          if (projectKey !== '') openProject(projectKey)
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
            // Present exactly when this issue came from a key lookup, whose
            // response is the same document the drawer would ask for.
            seeded: selectedIssue.key === resolved?.issue.key ? seededDetail : undefined,
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

export {
  AtlassianSettings,
  JiraBoardPanel,
  BoardPanelIcon,
  withMine,
  withProject,
  projectFilterOf,
  withSprint,
  sprintFilterOf,
  sprintChoices,
  togglePinned,
  pushRecent,
  openingPlan,
  canReuseProjects,
  issueKeyOf,
}

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
 * this panel, with no navigation code of our own. The pair is therefore one
 * unit, and the Settings switch removes both together.
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

  /** Registration returns a disposer, but the surface is typed loosely. */
  const asDisposer = (value: unknown): (() => void) =>
    typeof value === 'function' ? (value as () => void) : () => undefined

  const entries: (() => void)[] = []
  // The slot types are declarations owned by the shell; both must be present
  // before either registration makes sense. `inject` reports each one, and
  // sync() re-runs when the second arrives or the preference changes.
  let panelSlot = false
  let mainSlot = false

  const syncPanel = (): void => {
    const wanted = panelPrefs.value.panelVisible && panelSlot && mainSlot
    if (wanted && entries.length === 0) {
      entries.push(
        asDisposer(
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'Jira' },
            withContext(BoardPanelIcon as unknown as React.ComponentType<never>),
          ),
        ),
      )
      entries.push(
        asDisposer(
          ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            withContext(JiraBoardPanel as unknown as React.ComponentType<never>),
          ),
        ),
      )
    } else if (!wanted && entries.length > 0) {
      // `main` first: the layout clears a selection whose panel is no longer
      // registered, so the board cannot outlive the icon that opened it.
      for (const dispose of entries.splice(0).reverse()) dispose()
    }
  }

  ctx.slots.inject('sidebar.panellist', () => {
    panelSlot = true
    syncPanel()
  })
  ctx.slots.inject('main', () => {
    mainSlot = true
    syncPanel()
  })

  const stop = subscribePanelPrefs(syncPanel)
  ctx.effect?.(
    () => () => {
      stop()
      // The registrations were made through `register()` directly, so their
      // disposers are ours to run rather than the injection effect's.
      for (const dispose of entries.splice(0)) dispose()
    },
    'atlassian: panel entries',
  )

  // One read per page load. Until it lands the panel stays visible, which is
  // also the safe answer when the route is missing or the request is fenced.
  void loadPanelPrefs()
}

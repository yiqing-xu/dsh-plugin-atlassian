// Exercises the compiled client bundle's registration contract.
//
// A browser is not available here, so this harness supplies the two globals the
// bundle touches at materialization time (`window.__ModuleLoader__` and
// `document`) and then asserts what the plugin registers: the slots it injects
// into, and the ids/keys it claims in each. That is the part a bundling mistake
// or a slot-name typo breaks, and it is invisible until the page fails to render.
//
// Run with: node dev/verify-client-bundle.mjs

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Style tags the bundle appends at materialization time. */
const appendedStyles = []

globalThis.document = {
  createElement: () => {
    const attributes = {}
    return {
      attributes,
      setAttribute: (name, value) => {
        attributes[name] = value
      },
      textContent: '',
    }
  },
  head: { appendChild: (node) => appendedStyles.push(node) },
  implementation: { createDocument: () => ({ documentElement: { setAttribute: () => undefined, appendChild: () => undefined } }) },
  querySelectorAll: () => [],
  body: {},
}

/** The factory the bundle registers, captured from the module-loader facade. */
let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry
    },
  },
}

const source = await readFile(join(root, 'lib/client.js'), 'utf8')
// The bundle is a script for the browser, not a module: evaluate it the way the
// page does, with `window` in scope.
new Function('window', 'document', source)(globalThis.window, globalThis.document)

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('bundle')
check('registers a factory', captured !== undefined && typeof captured.factory === 'function')
check('registers under the package name', captured?.id === 'dsh-plugin-atlassian', String(captured?.id))

/**
 * The browser module loader's `require`, as the runtime implements it.
 *
 * `react` is a platform seed word — the page always provides it. Anything else
 * is a packaging failure: the client half is compiled as one program precisely
 * so that no other specifier can appear.
 */
const platformSeed = {
  react: {
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
    useContext: () => ({}),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useState: (initial) => [initial, () => undefined],
    useEffect: () => undefined,
    useRef: (initial) => ({ current: initial }),
    createContext: (value) => ({ Provider: 'Provider', _value: value }),
  },
}

const requireStub = (spec) => {
  if (spec in platformSeed) return platformSeed[spec]
  throw new Error(`client bundle required "${spec}" — it must stay a single file with no imports`)
}

// Materialization is what runs the module body — and therefore what emits the
// stylesheet, exactly as `dsh-client-modules` claims it.
const exports = captured.factory(requireStub)

check('claims one stylesheet at materialization', appendedStyles.length === 1, String(appendedStyles.length))
check(
  'tags the stylesheet for HMR bookkeeping',
  appendedStyles[0]?.attributes?.['data-plugin-css'] === 'dsh-plugin-atlassian',
  JSON.stringify(appendedStyles[0]?.attributes),
)
check(
  'the stylesheet has content',
  typeof appendedStyles[0]?.textContent === 'string' && appendedStyles[0].textContent.length > 100,
)
// The panel is a guest inside the shell's theme: its text and borders must ride
// the `--dsw-alias-*` tokens, because a literal light colour is unreadable once
// the shell switches to its dark palette.
const sheet = appendedStyles[0]?.textContent ?? ''
check(
  'reads the shell palette instead of assuming light mode',
  /--dsw-alias-label-primary/.test(sheet) && /--dsw-alias-border-l3/.test(sheet),
)
check('adapts semantic colours to the active theme', /color-mix\(in srgb/.test(source))
check('exports a plugin name', exports.name === 'dsh-plugin-atlassian', String(exports.name))
check(
  'injects only the known slots service',
  Array.isArray(exports.inject) && exports.inject.length === 1 && exports.inject[0] === 'slots',
  JSON.stringify(exports.inject),
)

/** Record what the plugin registers, with the injected slot keys. */
function makeContext() {
  const injections = []
  const registrations = []
  const live = new Map()
  const keyOf = (options) => `${String(options.name)}:${String(options.id ?? options.key ?? '')}`
  const ctx = {
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
        return () => undefined
      },
      register(options, component) {
        const entry = { options, component }
        registrations.push(entry)
        live.set(keyOf(options), entry)
        // The real service returns a disposer; the preference switch depends on
        // that being honoured, so the stub must not return the component.
        return () => {
          live.delete(keyOf(options))
        }
      },
    },
  }
  return { ctx, injections, registrations, live }
}

// The panel preference is read over HTTP at apply time. Answer that one
// request here so the harness never needs a running host; the payload is
// changed between applies to drive the hide/show transitions.
let prefsBody = { ok: true, prefs: { panelVisible: true } }
const fetched = []
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ url: String(url), method: init.method ?? 'GET' })
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(prefsBody)
    },
  }
}

const first = makeContext()
const { ctx: fakeCtx, injections, registrations, live } = first

console.log('\napply()')
exports.apply(fakeCtx)
// Let the preference read settle before asserting on the registration set.
await new Promise((resolve) => setTimeout(resolve, 0))

check('injects settings.section', injections.includes('settings.section'), JSON.stringify(injections))
check('injects sidebar.panellist', injections.includes('sidebar.panellist'), JSON.stringify(injections))
check('injects main', injections.includes('main'), JSON.stringify(injections))
check('injects exactly three slots', injections.length === 3, JSON.stringify(injections))

const settings = registrations.find((entry) => entry.options.name === 'settings.section')
const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.options.name === 'main')

check('registers the settings section', settings !== undefined)
check('settings id is its own', settings?.options.id === 'atlassian', String(settings?.options.id))
check('settings label matches the nav patch', settings?.options.label === 'Atlassian', String(settings?.options.label))

check('registers the sidebar panel', panel !== undefined)
check('panel id is the board id', panel?.options.id === 'jira-board', String(panel?.options.id))
check('panel carries a label', typeof panel?.options.label === 'string' && panel.options.label !== '')

check('registers the main panel', main !== undefined)
// The whole navigation story is that these two agree: `sidebar.panellist` ids
// address the keyed `main` panel, so a mismatch silently yields a dead icon.
check(
  'panel id and main key agree',
  panel?.options.id !== undefined && panel?.options.id === main?.options.key,
  `${String(panel?.options.id)} vs ${String(main?.options.key)}`,
)

for (const [label, entry] of [['settings', settings], ['panel', panel], ['main', main]]) {
  check(`${label} is a component`, typeof entry?.component === 'function')
}

// ---------------------------------------------------------------------------
// Sidebar panel preference
// ---------------------------------------------------------------------------
//
// The switch is a host document, and the registration itself follows it: the
// sidebar entry and its keyed main panel are one unit, so hiding must withdraw
// both and showing must put both back. A persistent hide would otherwise leave
// a dead icon, and a stale main entry a board nobody can navigate away from.

console.log('\npanel preference')
check(
  'reads the preference on load',
  fetched.some((entry) => entry.url.endsWith('/prefs') && entry.method === 'GET'),
  JSON.stringify(fetched),
)
check('renders a switch', /role: 'switch'/.test(source))
check(
  'persists the switch choice',
  /\/prefs', 'POST'/.test(source) && /panelVisible: visible/.test(source),
)

prefsBody = { ok: true, prefs: { panelVisible: false } }
const second = makeContext()
exports.apply(second.ctx)
await new Promise((resolve) => setTimeout(resolve, 10))
check(
  'hiding withdraws the sidebar entry',
  !second.live.has('sidebar.panellist:jira-board'),
  [...second.live.keys()].join(','),
)
check('hiding withdraws the main panel', !second.live.has('main:jira-board'), [...second.live.keys()].join(','))
check('settings stays registered', second.live.has('settings.section:atlassian'), [...second.live.keys()].join(','))

prefsBody = { ok: true, prefs: { panelVisible: true } }
exports.apply(makeContext().ctx)
await new Promise((resolve) => setTimeout(resolve, 10))
check(
  'showing restores the sidebar entry',
  second.live.has('sidebar.panellist:jira-board'),
  [...second.live.keys()].join(','),
)
check('showing restores the main panel', second.live.has('main:jira-board'), [...second.live.keys()].join(','))

// ---------------------------------------------------------------------------
// Prompt delivery contract
// ---------------------------------------------------------------------------
//
// The hand-over path must reach a session through its Session object, never
// through a scoped context: `scope(id)` returns a no-op fiber's ctx, and Cordis
// gates service PROPERTY access on a context that declines `inject`
// (`cannot get property "remote" without inject`). Comments legitimately name
// that old access in prose, so strip them before matching code.

const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

console.log('\nprompt delivery')
check('does not read a scoped context\'s remote in code', !/scope\([^)]*\)\.remote/.test(code))
check('reads the session through binding(), 0.2.0 and 0.1.x', /\.binding\?\.\(/.test(code))
check('uses sessions.using() to materialize an unretained session', /\.using\(/.test(code))
check(
  "calls prompt(content, 'queue', undefined, requestId)",
  /content,\s*'queue',\s*undefined,\s*requestId/.test(code),
)
// A dispatched issue must queue behind the current turn, never interrupt it.
check('delivers with mode "queue", not "steer"', !/'steer'/.test(code))

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------
//
// The Settings page lists every bridged tool with the server's description.
// The data comes from `GET /tools`, not from the status poll.

console.log('\ntool catalogue')
check('requests the catalogue endpoint', /'\/tools'/.test(code))
check('renders the server description', /tool\.description/.test(code))
check('filters by name and description', /tool\.rawName/.test(code))

// ---------------------------------------------------------------------------
// 断开连接 vs 退出登录
// ---------------------------------------------------------------------------
//
// The two buttons mean different things and must stay different: 断开连接 takes
// the tools out of the agent's context while keeping the authorization, so a
// reconnect is silent; 退出登录 is the destructive one. A regression that merged
// them would either sign the user out on a mere toggle or leave the tools
// registered after they switched them off.

console.log('\n断开连接 vs 退出登录')
check('offers a separate sign-out action', /act\('forget'\)/.test(code))
check('disconnect does not promise a sign-out', /act\('disconnect'\)/.test(code))
check('names the resume state in the connect button', /status === 'disconnected' \? '重新连接'/.test(code))
check('renders the suspended status', /disconnected: '已断开'/.test(code))
check('only offers sign-out with a stored authorization', /authorized === true/.test(code))
check('keeps the suspend button off in the suspended state', /status !== 'idle' && status !== 'disconnected'/.test(code))
check('tells the suspended board how to resume', /不需要再次授权/.test(code))
check('explains the suspended state in Settings', /已断开（授权保留）/.test(code))
check('drops a stale board when suspended', /status\.status === 'idle' \|\| status\.status === 'disconnected'/.test(code))

// ---------------------------------------------------------------------------
// Board memory between openings
// ---------------------------------------------------------------------------
//
// The layout renders exactly one `main` entry, so selecting another panel
// unmounts this one and its React state is gone when the user comes back. The
// snapshot is what keeps a reopening from becoming an empty board plus a Jira
// round-trip. Its reuse rule is pure, so the policy is pinned here: a cached
// board is good while it answers THIS query and is younger than one poll
// period, and anything else must be fetched.

console.log('\nboard memory')
const planFor = exports.openingPlan
const remembered = {
  board: { ok: true, issues: [] },
  updatedAt: 1_000,
  jql: 'project = DEMO',
  configJql: '',
  viewId: 'active',
  project: 'all',
  category: 'all',
  mine: false,
  query: '',
}

check('exposes the opening plan', typeof planFor === 'function')
if (typeof planFor === 'function') {
  check('paints a board inside the poll period', planFor(remembered, 'project = DEMO', 1_000 + 59_999) === 'paint')
  check('revalidates one older than the poll period', planFor(remembered, 'project = DEMO', 1_000 + 60_000) === 'revalidate')
  check(
    'reads when the remembered board answers another query',
    planFor(remembered, 'project = OTHER', 2_000) === 'read',
  )
  check(
    'reads when the entry has no payload',
    planFor({ ...remembered, board: undefined }, 'project = DEMO', 2_000) === 'read',
  )
  check('reads when nothing was loaded yet', planFor(undefined, 'project = DEMO', 2_000) === 'read')
}
check('keeps the snapshot outside the component', /let boardSnapshot;/.test(code))
check('paints the remembered board on open', /React\.useState\(restored\?\.board\)/.test(code))
check('revalidates a restored board without blanking it', /refresh\(\{ quiet: true \}\)/.test(code))
check('does not re-ask for /status it just read', /lastStatus\?\.at/.test(code))
check('stops a failed sync from replacing a readable board', /error !== undefined && board === undefined/.test(code))
check('refreshes from the header block', /'data-dsh-jira-refresh': '1'/.test(code))
check('names the header refresh for assistive tech', /'aria-label': '刷新 Jira 看板'/.test(code))
check('reports a refresh in the header', /刷新中…/.test(code))

// ---------------------------------------------------------------------------
// "Assigned to me" JQL folding
// ---------------------------------------------------------------------------
//
// The chip is a SERVER-side constraint, so what it produces is the whole
// feature: JQL puts ORDER BY last, and the fold must be idempotent so toggling
// the chip over a query the user typed cannot duplicate the clause.

console.log('\nwithMine()')
const MINE = 'assignee = currentUser()'
const fold = exports.withMine

check('is exported', typeof fold === 'function')
check('off leaves the query alone', fold('project = DEMO', false) === 'project = DEMO')
if (typeof fold === 'function') {
  check(
    'appends to a query with no ordering',
    fold('project = DEMO', true) === `project = DEMO AND ${MINE}`,
    fold('project = DEMO', true),
  )
  check(
    'inserts BEFORE the trailing ORDER BY',
    fold('updated >= -180d ORDER BY updated DESC', true) === `updated >= -180d AND ${MINE} ORDER BY updated DESC`,
    fold('updated >= -180d ORDER BY updated DESC', true),
  )
  check(
    'keeps a lowercase order by last',
    fold('project = DEMO order by created', true) === `project = DEMO AND ${MINE} order by created`,
    fold('project = DEMO order by created', true),
  )
  check(
    'handles a query that is only an ORDER BY',
    fold('ORDER BY updated DESC', true) === `${MINE} ORDER BY updated DESC`,
    fold('ORDER BY updated DESC', true),
  )
  check('turns an empty query into the clause', fold('', true) === MINE, fold('', true))
  check('is idempotent on its own output', fold(fold('project = DEMO', true), true) === `project = DEMO AND ${MINE}`)
  check(
    'does not duplicate a case-variant clause the user typed',
    fold('assignee=CURRENTUSER() AND project = DEMO', true) === 'assignee=CURRENTUSER() AND project = DEMO',
    fold('assignee=CURRENTUSER() AND project = DEMO', true),
  )
  check(
    'leaves an already-filtered query alone when toggled off',
    fold(`project = DEMO AND ${MINE}`, false) === `project = DEMO AND ${MINE}`,
  )
}

// ---------------------------------------------------------------------------
// Opening one issue by key or link
// ---------------------------------------------------------------------------
//
// The search box filters the loaded page, which cannot contain an issue from
// another page or another view. A bare key or a pasted Jira link is an EXACT
// question, so it is answered by the server; anything else must stay an
// ordinary substring filter, or typing a sentence would navigate the board.

console.log('\nissueKeyOf()')
const keyOf = exports.issueKeyOf

check('is exported', typeof keyOf === 'function')
if (typeof keyOf === 'function') {
  check('reads a bare key', keyOf('HMHP-111') === 'HMHP-111', keyOf('HMHP-111'))
  check('accepts a lower-case key', keyOf('hmhp-111') === 'HMHP-111', keyOf('hmhp-111'))
  check('ignores surrounding whitespace', keyOf('  DEMOAPP-27  ') === 'DEMOAPP-27', keyOf('  DEMOAPP-27  '))
  check('accepts underscores in the project key', keyOf('DEMO_APP-9') === 'DEMO_APP-9', keyOf('DEMO_APP-9'))
  check(
    'reads a /browse/ link',
    keyOf('https://example.atlassian.net/browse/DEMOAPP-27') === 'DEMOAPP-27',
    keyOf('https://example.atlassian.net/browse/DEMOAPP-27'),
  )
  check(
    'reads a link with a query string and a fragment',
    keyOf('https://example.atlassian.net/browse/DEMOAPP-27?atlOrigin=abc#comment-1') === 'DEMOAPP-27',
    keyOf('https://example.atlassian.net/browse/DEMOAPP-27?atlOrigin=abc#comment-1'),
  )
  check(
    'reads a board link carrying selectedIssue',
    keyOf('https://example.atlassian.net/jira/software/projects/DEMOAPP/boards/1?selectedIssue=DEMOAPP-27') ===
      'DEMOAPP-27',
    keyOf('https://example.atlassian.net/jira/software/projects/DEMOAPP/boards/1?selectedIssue=DEMOAPP-27'),
  )
  check(
    'reads an /issues/ link',
    keyOf('https://example.atlassian.net/issues/DEMOAPP-27') === 'DEMOAPP-27',
    keyOf('https://example.atlassian.net/issues/DEMOAPP-27'),
  )
  check(
    'decodes a percent-encoded link',
    keyOf('https://example.atlassian.net/browse/DEMOAPP-27?from=board%20view') === 'DEMOAPP-27',
  )
  check('a summary is not a key', keyOf('等级铭牌与奖励结算反馈') === undefined, String(keyOf('等级铭牌与奖励结算反馈')))
  check('a sentence containing a key is not one', keyOf('请看一下 DEMOAPP-27 的进度') === undefined)
  check('an empty box is not a lookup', keyOf('   ') === undefined)
  check('a link without a key is not a lookup', keyOf('https://example.atlassian.net/secure/Dashboard.jspa') === undefined)
  check('a number alone is not a key', keyOf('12345') === undefined, String(keyOf('12345')))
}

check(
  'issues a by-key lookup through the issue endpoint',
  /api\(`\/issue\/\$\{encodeURIComponent\(key\)\}`/.test(code),
)
check('opens the drawer on the resolved issue', /setSelected\(detail\.issue\.key\)/.test(code))
check(
  'folds a by-key issue into the board so its actions work',
  /\[pinned, \.\.\.loaded\]/.test(code),
)
check(
  'a by-key lookup takes over the board view',
  /if \(pinned !== undefined\)\s*return \[pinned\]/.test(code),
)
check(
  'the drawer reuses the lookup instead of re-reading the issue',
  /seeded === undefined/.test(code) && /api\(`\/issue\/\$\{encodeURIComponent\(key\)\}`/.test(code),
)
check(
  'an answer with no issue inside is rejected, not stored',
  /detail\.issue === undefined \|\| detail\.issue\.key === undefined/.test(code),
)
check('explains a key that is not on the page instead of reporting no cards', /按编号打开 \$\{pendingKey\}/.test(code))
check('clearing the search drops the by-key result', /setResolved\(undefined\)/.test(code))

// ---------------------------------------------------------------------------
// Sprint filter
// ---------------------------------------------------------------------------
//
// Sprint is a SERVER-side constraint, exactly like "assigned to me": the board
// holds one bounded page, so filtering the page it happens to hold would report
// an empty sprint whose issues simply fell on another page. What the chips
// produce is therefore the whole feature, and it is pinned here.

console.log('\nwithSprint()')
const sprinted = exports.withSprint
const sprintOf = exports.sprintFilterOf

check('is exported', typeof sprinted === 'function')
check('the read-back is exported', typeof sprintOf === 'function')
if (typeof sprinted === 'function') {
  check('all leaves the query alone', sprinted('project = DEMO', 'all') === 'project = DEMO')
  check(
    'open folds in openSprints()',
    sprinted('project = DEMO', 'open') === 'project = DEMO AND sprint IN openSprints()',
    sprinted('project = DEMO', 'open'),
  )
  check(
    'empty folds in IS EMPTY',
    sprinted('project = DEMO', 'empty') === 'project = DEMO AND sprint IS EMPTY',
    sprinted('project = DEMO', 'empty'),
  )
  check(
    'one sprint folds in its id',
    sprinted('project = DEMO', 'id:5740') === 'project = DEMO AND sprint = 5740',
    sprinted('project = DEMO', 'id:5740'),
  )
  check(
    'the clause lands BEFORE the trailing ORDER BY',
    sprinted('updated >= -180d ORDER BY updated DESC', 'id:5740') ===
      'updated >= -180d AND sprint = 5740 ORDER BY updated DESC',
    sprinted('updated >= -180d ORDER BY updated DESC', 'id:5740'),
  )
  check(
    'a query that is only an ORDER BY gets no leading AND',
    sprinted('ORDER BY updated DESC', 'open') === 'sprint IN openSprints() ORDER BY updated DESC',
    sprinted('ORDER BY updated DESC', 'open'),
  )
  check(
    'an unrecognized selection is ignored rather than emitted',
    sprinted('project = DEMO', 'nonsense') === 'project = DEMO',
    sprinted('project = DEMO', 'nonsense'),
  )
  check(
    'stacks with the assignee fold',
    sprinted(`project = DEMO AND ${MINE}`, 'open') === `project = DEMO AND ${MINE} AND sprint IN openSprints()`,
    sprinted(`project = DEMO AND ${MINE}`, 'open'),
  )
}
if (typeof sprintOf === 'function') {
  check(
    'reads openSprints() back',
    sprintOf('project = DEMO AND sprint IN openSprints()') === 'open',
    sprintOf('project = DEMO AND sprint IN openSprints()'),
  )
  check('reads IS EMPTY back', sprintOf('sprint IS EMPTY') === 'empty', sprintOf('sprint IS EMPTY'))
  check('reads one id back', sprintOf('sprint = 5740') === 'id:5740', sprintOf('sprint = 5740'))
  check('reads a quoted id back', sprintOf('sprint = "5740"') === 'id:5740', sprintOf('sprint = "5740"'))
  check('no clause means all', sprintOf('project = DEMO') === 'all', sprintOf('project = DEMO'))
  // The read-back is what keeps a chip honest after a hand-written JQL commit:
  // what it finds must be exactly what the fold would emit.
  check('round-trips the fold', sprintOf(sprinted('project = DEMO', 'open')) === 'open')
}

console.log('\nsprintChoices()')
const choicesOf = exports.sprintChoices
const sprintStatus = { name: 'S', categoryKey: 'new', categoryName: '待办', colorName: 'blue-gray' }
const issueWith = (key, sprints) => ({ key, summary: '', type: '', status: sprintStatus, sprints })
check('is exported', typeof choicesOf === 'function')
if (typeof choicesOf === 'function') {
  // The catalogue is the authority for WHICH sprints exist: a sprint is a named
  // option on the project, and a closed one the user still filters by need not
  // appear on the current page at all.
  const catalogue = [
    { id: '3002', name: '中海油零库存信创部署', state: 'closed', endDate: '2025-11-11T10:00:00.000Z' },
    { id: '5777', name: '中海油备件零库存 lkc_8', state: 'closed', endDate: '2026-06-18T10:00:00.000Z' },
    { id: '5603', name: '中海油备件零库存 lkc_9', state: 'future' },
    { id: '6001', name: '镇海炼化冲刺15.5', state: 'active', endDate: '2026-11-01T10:00:00.000Z' },
  ]
  const page = [
    issueWith('A-1', [
      { id: '6001', name: '镇海炼化冲刺15.5', state: 'active' },
      { id: '3002', name: '中海油零库存信创部署', state: 'closed' },
    ]),
    issueWith('A-2', [{ id: '6001', name: '镇海炼化冲刺15.5', state: 'active' }]),
    issueWith('A-3', []),
  ]
  const choices = choicesOf(catalogue, page)
  check('every catalogue sprint is offered', choices.length === 4, JSON.stringify(choices.map((c) => c.id)))
  check('the active sprint leads', choices[0]?.id === '6001', choices[0]?.id)
  check('a future sprint comes before closed ones', choices[1]?.id === '5603', choices[1]?.id)
  check(
    'closed sprints are newest first',
    choices[2]?.id === '5777' && choices[3]?.id === '3002',
    `${choices[2]?.id},${choices[3]?.id}`,
  )
  check('counts cards on the page', choices[0]?.count === 2, String(choices[0]?.count))
  check('a sprint with no card still has a chip, count 0', choices[2]?.count === 0, String(choices[2]?.count))
  check(
    'a closed sprint absent from the page is still selectable',
    choices.some((entry) => entry.id === '5777' && entry.state === 'closed'),
  )

  // A sprint the page carries but the catalogue missed must not become
  // unfilterable: the two sources are merged, not replaced.
  const partial = choicesOf([{ id: '6001', name: '镇海炼化冲刺15.5', state: 'active' }], page)
  check('a page-only sprint is appended', partial.some((entry) => entry.id === '3002'), JSON.stringify(partial.map((c) => c.id)))
  check('the catalogue entry wins for the same id', partial.filter((entry) => entry.id === '6001').length === 1)

  // Before the catalogue has loaded, the page's own sprints are the whole list —
  // the chips must still work rather than showing an empty row.
  const pageOnly = choicesOf([], page)
  check('works with no catalogue at all', pageOnly.length === 2, JSON.stringify(pageOnly.map((c) => c.id)))

  const dupes = choicesOf(catalogue, [issueWith('A-4', [{ id: '6001', name: 'dup', state: 'active' }])])
  check('an id seen twice yields one entry', dupes.filter((entry) => entry.id === '6001').length === 1)
}

check('the sprint row is rendered', /'data-dsh-jira-sprints': '1'/.test(code))
check('the catalogue is fetched from the server', /`\/sprints\?project=\$\{encodeURIComponent\(sprintProject\)\}`/.test(code))
check('the picker replaces one-chip-per-sprint', /data-dsh-jira-sprint-picker/.test(code))
check('a picked sprint becomes a server-side clause', /sprint = \$\{id\}/.test(code))
check('the coarse chips are gone, the picker alone filters', !/未完成冲刺|无冲刺/.test(code))
// Both picker lists must sit on the panel's opaque surface. The translucent
// `C.menu` layer is allowed exactly once — the hand-off menu, which floats over
// quiet chrome with a blur, never over the card wall.
const menuBgCount = (code.match(/background: C\.menu,?/g) ?? []).length
check('the picker lists are opaque', (code.match(/C\.pickerList/g) ?? []).length >= 2 && menuBgCount <= 1, JSON.stringify({ pickerList: (code.match(/C\.pickerList/g) ?? []).length, menuBg: menuBgCount }))
check('clearing the filters resets the sprint too', /setSprint\(SPRINT_ALL\)/.test(code))
check('a hand-written JQL re-seeds the sprint chip', /setSprint\(sprintFilterOf\(text\)\)/.test(code))
check(
  'the snapshot carries the sprint filter',
  /writeBoardSnapshot\(\{ viewId, override, project, category, sprint, mine, query \}\)/.test(code),
)
check(
  'the JQL box shows the sprint clause',
  /withSprint\(withMine\(withProject\(override \?\? activeView\.jql, project\), mine\), sprint\)/.test(code),
)

// ---------------------------------------------------------------------------
// Project catalogue cache
// ---------------------------------------------------------------------------
//
// Reopening the panel must not flash "读取项目…" again: the catalogue joins the
// board snapshot and is painted from it, refetching only past the TTL or on the
// explicit 刷新. Functional assertions run on the exported predicate; the
// wiring is asserted on the compiled source.

console.log('\nproject catalogue cache')
const reusable = exports.canReuseProjects
check('is exported', typeof reusable === 'function')
if (typeof reusable === 'function') {
  const catalogue = { projects: [{ key: 'A', name: '', updated: '' }], projectsAt: 1_000 }
  check('a fresh catalogue is reused', reusable(catalogue, 1_000 + 3_600_000 - 1) === true)
  check('an expired catalogue is not', reusable(catalogue, 1_000 + 3_600_000) === false)
  check('no catalogue is not', reusable(undefined, 1_000) === false)
  check('a catalogue without a timestamp is not', reusable({ projects: [{ key: 'A', name: '', updated: '' }] }, 1_000) === false)
}

check('the catalogue is cached into the board snapshot', /writeBoardSnapshot\(\{ projects: list, projectsAt: Date\.now\(\) \}\)/.test(code))
check(
  'a reopen inside the TTL paints the cache and asks nothing',
  /canReuseProjects\(snapshot, Date\.now\(\)\)\)\s*\n?\s*return/.test(code),
)
check(
  'the refresh button still refetches',
  /void loadProjects\(\);?\s*\n\s*void refresh\(\)/.test(code),
)

// ---------------------------------------------------------------------------
// Pinned projects
// ---------------------------------------------------------------------------
//
// A pin reorders the project row and nothing else. The order is the order the
// user clicked, which is only true if a pin APPENDS — so that rule is pinned
// here rather than left to whichever click handler happens to call it.

console.log('\ntogglePinned()')
const toggle = exports.togglePinned

check('is exported', typeof toggle === 'function')
if (typeof toggle === 'function') {
  check('pinning an empty list yields one pin', toggle([], 'PICDLY').join(',') === 'PICDLY')
  check(
    'a new pin appends, it does not prepend',
    toggle(['PICDLY'], 'HMHP').join(',') === 'PICDLY,HMHP',
    toggle(['PICDLY'], 'HMHP').join(','),
  )
  check(
    'pinning an already pinned project removes it',
    toggle(['PICDLY', 'HMHP'], 'PICDLY').join(',') === 'HMHP',
    toggle(['PICDLY', 'HMHP'], 'PICDLY').join(','),
  )
  check(
    'removing keeps the rest in order',
    toggle(['A', 'B', 'C'], 'B').join(',') === 'A,C',
    toggle(['A', 'B', 'C'], 'B').join(','),
  )
  check('unpinning the only pin leaves none', toggle(['PICDLY'], 'PICDLY').length === 0)
  check(
    'the input list is not mutated',
    (() => {
      const original = ['A']
      toggle(original, 'B')
      return original.join(',') === 'A'
    })(),
  )
}

check('the project chip offers a pin', /'data-dsh-jira-pin'/.test(code))

// ---------------------------------------------------------------------------
// Recent projects
// ---------------------------------------------------------------------------
//
// A real site holds far more projects than a row can show (this one lists 148).
// The row therefore carries a short "recently opened" strip — the Jira sidebar's
// own idea — so the ORDER is the feature: newest first, a repeat moves rather
// than duplicates, and the list stays short enough to scan.

console.log('\npushRecent()')
const recent = exports.pushRecent

check('is exported', typeof recent === 'function')
if (typeof recent === 'function') {
  check('the first open yields one entry', recent([], 'HMHP').join(',') === 'HMHP')
  check('the newest open leads', recent(['A'], 'B').join(',') === 'B,A', recent(['A'], 'B').join(','))
  check('re-opening moves it to the front', recent(['A', 'B', 'C'], 'C').join(',') === 'C,A,B', recent(['A', 'B', 'C'], 'C').join(','))
  check('re-opening does not duplicate', recent(['A', 'B'], 'A').filter((entry) => entry === 'A').length === 1)
  check('the strip is bounded', recent(Array.from({ length: 20 }, (_, index) => `P${String(index)}`), 'NEW').length === 8)
  check('the oldest entry falls off the end', recent(Array.from({ length: 8 }, (_, index) => `P${String(index)}`), 'NEW').includes('P7') === false)
  check(
    'the input list is not mutated',
    (() => {
      const original = ['A']
      recent(original, 'B')
      return original.join(',') === 'A'
    })(),
  )
}

// The pin is a second real button beside the chip's, never nested inside it: a
// button cannot contain another interactive element.
check('the pin is its own button, not a nested one', /key: 'pin',\s*type: 'button'/.test(code))
check('pins are persisted, not just remembered', /savePinnedProjects\(/.test(code))
check('a pin write goes to the prefs endpoint', /'\/prefs', 'POST', \{ pinnedProjects/.test(code))
check(
  'the row puts pins before recents',
  /for \(const key of pinnedProjects\)\s*push\(key\)/.test(code) &&
    /for \(const key of recentProjects\)\s*push\(key\)/.test(code),
)
check('recent projects are persisted', /saveRecentProjects/.test(code))
check('the full catalogue is reachable', /data-dsh-jira-project-picker/.test(code))

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------
//
// The project row is the board's SCOPE, not another optional chip: the row is
// built from the site's whole project list and there is no "全部" entry, because
// the site-wide query is what hid the project the user was looking for. What
// makes that true is the JQL fold, so it is pinned here.

console.log('\nwithProject()')
const projectFold = exports.withProject
const projectOf = exports.projectFilterOf

check('is exported', typeof projectFold === 'function')
if (typeof projectFold === 'function') {
  check(
    'appends the scope to an unconstrained view',
    projectFold('updated >= -180d ORDER BY updated DESC', 'DEMOAPP') ===
      'updated >= -180d AND project = DEMOAPP ORDER BY updated DESC',
    projectFold('updated >= -180d ORDER BY updated DESC', 'DEMOAPP'),
  )
  check('a query that is only an ORDER BY keeps it last', projectFold('ORDER BY updated DESC', 'DEMO') === 'project = DEMO ORDER BY updated DESC')
  check('an empty query becomes the scope', projectFold('', 'DEMO') === 'project = DEMO')
  check(
    'rewrites an existing project clause rather than stacking a second one',
    projectFold('project = OLD ORDER BY created', 'NEW') === 'project = NEW ORDER BY created',
    projectFold('project = OLD ORDER BY created', 'NEW'),
  )
  check('rewrites a quoted key too', projectFold('project = "OLD"', 'NEW') === 'project = NEW')
  check(
    'leaves a set-shaped restriction alone',
    projectFold('project in (A, B)', 'C') === 'project in (A, B)',
    projectFold('project in (A, B)', 'C'),
  )
  check('an empty project changes nothing', projectFold('project = DEMO', '') === 'project = DEMO')
  check('is idempotent on its own output', projectFold(projectFold('', 'DEMO'), 'DEMO') === 'project = DEMO')
}

check('projectFilterOf is exported', typeof projectOf === 'function')
if (typeof projectOf === 'function') {
  check('reads a committed project back out of the JQL', projectOf('project = DEMO AND assignee = currentUser()') === 'DEMO')
  check('upper-cases it', projectOf('project = demo') === 'DEMO')
  check('no project clause means no selection', projectOf('updated >= -180d') === '')
  check('a set-shaped restriction names no single project', projectOf('project in (A, B)') === '')
}

// The row itself: every project, no "全部", one scope always selected.
check('the project row comes from the server list', /const projects = React\.useMemo/.test(code) && /projectList\]/.test(code))
check('no "全部" project chip', /setProject\('all'\)/.test(code) === false)
check('the project is part of the effective JQL', /withProject\(override \?\? activeView\.jql, project\)/.test(code))
check('a board read is refused with no project', /if \(project\.trim\(\) === ''\) \{/.test(code))
check('the selected project shows its own count', /count: project === entry\.key \? issues\.length : undefined/.test(code))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

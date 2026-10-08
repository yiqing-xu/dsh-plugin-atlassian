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
check('exports a plugin name', exports.name === 'dsh-plugin-atlassian', String(exports.name))
check(
  'injects only the known slots service',
  Array.isArray(exports.inject) && exports.inject.length === 1 && exports.inject[0] === 'slots',
  JSON.stringify(exports.inject),
)

/** Record what the plugin registers, with the injected slot keys. */
const injections = []
const registrations = []
const fakeCtx = {
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
      return () => undefined
    },
    register(options, component) {
      registrations.push({ options, component })
      return component
    },
  },
}

console.log('\napply()')
exports.apply(fakeCtx)

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

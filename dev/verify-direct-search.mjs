// Renders the compiled board in a real DOM and drives the search box.
//
// The other client harness stops at the bundle's registration contract; this one
// goes one level deeper and actually MOUNTS `JiraBoardPanel` with react-dom, then
// types into the search box and presses Enter. That is the only way to prove the
// thing a user does — paste a key or a Jira link, hit Enter, land on the issue —
// without a live Atlassian authorization, and it covers the part that is easy to
// get wrong: a by-key issue has to survive the filter chips and the empty page.
//
// react-dom and jsdom are NOT dependencies of this package (a client plugin ships
// one bundle and no test runner), so this harness looks for them in a scratch
// install and says how to make one when they are absent:
//
//   mkdir %TEMP%\dsh-jira-domprobe && cd /d %TEMP%\dsh-jira-domprobe
//   npm init -y && npm i react@18.3.1 react-dom@18.3.1 jsdom@24.1.3
//   node <repo>/dev/verify-direct-search.mjs %TEMP%\dsh-jira-domprobe
//
// Run with: node dev/verify-direct-search.mjs [dir-with-node_modules]

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = resolve(process.argv[2] ?? join(process.env.TEMP ?? '/tmp', 'dsh-jira-domprobe'))
const scratchRequire = createRequire(join(scratch, 'package.json'))

// `jsdom` is safe to load first: it does not inspect the global environment.
let JSDOM
try {
  ;({ JSDOM } = scratchRequire('jsdom'))
} catch (error) {
  console.error(`missing jsdom under ${scratch}`)
  console.error('install the scratch deps first (see this file\'s header), then re-run.')
  console.error(String(error))
  process.exit(2)
}

const SITE = 'example.atlassian.net'

/** What the fake `/board` answers: a page that does NOT contain the key typed. */
const BOARD = {
  issues: [
    {
      key: 'DEMOAPP-27',
      id: '10107',
      summary: '示例任务：等级铭牌与奖励结算反馈',
      status: { name: '开发中', categoryKey: 'indeterminate', categoryName: '正在进行', colorName: 'yellow' },
      type: '故事',
      priority: 'High',
      updated: '2026-09-17T03:44:29.154+0800',
      projectKey: 'DEMOAPP',
      projectName: '示例｜用户 App',
      url: `https://${SITE}/browse/DEMOAPP-27`,
    },
    {
      key: 'DEMOAPP-34',
      id: '10168',
      summary: '示例任务：地址与物流展示',
      status: { name: '待梳理', categoryKey: 'new', categoryName: '待办', colorName: 'blue-gray' },
      type: '故事',
      updated: '2026-09-17T03:44:48.983+0800',
      projectKey: 'DEMOAPP',
      projectName: '示例｜用户 App',
      url: `https://${SITE}/browse/DEMOAPP-34`,
    },
  ],
  constrained: false,
  jql: 'updated >= -180d AND statusCategory != Done ORDER BY updated DESC',
  site: SITE,
  truncated: false,
  limit: 50,
}

/** The issue the key lookup must find — outside the page above. */
const OUTSIDE = {
  key: 'HMHP-111',
  id: '20999',
  summary: '示例任务：从编号直达的工单',
  status: { name: '待办', categoryKey: 'new', categoryName: '待办', colorName: 'blue-gray' },
  type: '任务',
  updated: '2026-10-01T10:00:00.000+0800',
  projectKey: 'HMHP',
  projectName: '示例｜其它项目',
  url: `https://${SITE}/browse/HMHP-111`,
}

const requests = []
let failIssue = false
/** Answer a lookup with an envelope that carries no issue, to test the guard. */
let emptyIssue = false

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  requests.push({ url: target, method: init.method ?? 'GET' })
  const answer = (body) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body)
    },
  })
  if (target.endsWith('/status')) {
    return answer({
      ok: true,
      status: 'ready',
      site: SITE,
      siteMismatch: false,
      toolCount: 12,
      board: { jql: '', limit: 50, promptTemplate: '' },
    })
  }
  if (target.endsWith('/prefs')) return answer({ ok: true, prefs: { panelVisible: true } })
  // The project row is the board's SCOPE, so it is read from the site before any
  // board query is made; a harness that does not answer this leaves the panel
  // with no project and therefore no board.
  if (target.endsWith('/projects')) {
    return answer({
      ok: true,
      projects: [
        { key: 'DEMOAPP', name: '示例｜用户 App' },
        { key: 'HMHP', name: '示例｜其它项目' },
      ],
    })
  }
  if (target.startsWith('/plugins/atlassian/board')) return answer({ ok: true, ...BOARD })
  // Order matters: the detail route has to be matched before the transitions
  // route, or `/issue/X/transitions` would answer with an issue body and the
  // transitions read would silently receive the wrong document.
  if (target.includes('/transitions')) return answer({ ok: true, transitions: [] })
  if (target.includes(`/issue/${encodeURIComponent(OUTSIDE.key)}`)) {
    if (failIssue) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ ok: false, code: 'not-found', error: '该工单不存在或无权访问' })
        },
      }
    }
    if (emptyIssue) return answer({ ok: true })
    return answer({ ok: true, issue: OUTSIDE, description: '## 直达工单\n\n这是一条按编号查到的工单。' })
  }
  return answer({ ok: true })
}

// --- DOM ------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:5671/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// Node 24 defines `navigator` as a getter-only global; the bundle only reads it
// through `window`, so the property is left alone rather than overwritten.
globalThis.HTMLElement = window.HTMLElement
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.CustomEvent = window.CustomEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// react-dom decides `canUseDOM` when it is first LOADED, so it must be loaded
// only after the globals above exist — requiring it up front caches "no DOM",
// and every synthetic event is then dropped on the floor with no error at all.
const React = scratchRequire('react')
const ReactDOM = scratchRequire('react-dom/client')

/** Text of every element matching a selector, for readable assertions. */
const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => (node.textContent ?? '').trim())
void texts

// The bundle is a script for the browser; `.client.js` is wrapped by
// `window.__ModuleLoader__.load`, so capture the factory exactly as the page does.
let captured
window.__ModuleLoader__ = { load: (entry) => (captured = entry) }
const source = await readFile(join(root, 'lib/client.js'), 'utf8')
new Function('window', 'document', source)(window, window.document)

const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`client bundle required "${spec}" — it must stay a single file`)
}
const plugin = captured.factory(requireStub)

// React 18 exports `act` from react-dom/test-utils; React 19 moved it to
// `react`. Try both so the harness does not pin the scratch install's version.
const act = React.act ?? scratchRequire('react-dom/test-utils').act
const flush = async (times = 6) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (act !== undefined) await act(async () => undefined)
  }
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

/** The board panel, inside the context the plugin wraps it with. */
const Panel = plugin.JiraBoardPanel

const container = document.getElementById('root')
const reactRoot = ReactDOM.createRoot(container)

console.log('mount')
await act(async () => {
  reactRoot.render(React.createElement(Panel, {}))
})
await flush(10)
check('the board panel mounted', document.querySelector('[data-dsh-jira-board]') !== null)
check('the page rendered its issues', document.querySelectorAll('[data-dsh-jira-card]').length === 2,
  String(document.querySelectorAll('[data-dsh-jira-card]').length))

/** The search box: the only text input whose placeholder mentions 搜索. */
const searchBox = () => [...document.querySelectorAll('input')].find((input) => (input.placeholder ?? '').includes('搜索'))

/** Type into a controlled input the way React's onChange sees it. */
const type = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush(3)
}

const pressEnter = async (input) => {
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush(8)
}

const pressEscape = async (input) => {
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush(6)
}

console.log('\ntyping a key outside the page')
const box = searchBox()
check('the search box exists', box !== undefined)
if (box !== undefined) {
  await type(box, 'HMHP-111')
  check('no request is made while typing', requests.filter((entry) => entry.url.includes('/issue/')).length === 0,
    JSON.stringify(requests.filter((entry) => entry.url.includes('/issue/'))))
  const prompt = document.body.textContent ?? ''
  check('it offers the exact lookup instead of "no cards"', prompt.includes('按编号打开 HMHP-111'), prompt.slice(0, 160))
  check('it does not claim the issue is missing', !prompt.includes('当前筛选下没有工单'))

  await pressEnter(box)
  const asked = requests.filter((entry) => entry.url.includes('/issue/') && !entry.url.endsWith('/transitions'))
  check('Enter asks the server once for the issue', asked.length === 1, JSON.stringify(asked))
  check('it asks for the key that was typed', asked[0]?.url.includes(encodeURIComponent('HMHP-111')), JSON.stringify(asked))
  check(
    'the drawer reuses that answer instead of asking again',
    requests.filter((entry) => entry.url === `/plugins/atlassian/issue/${encodeURIComponent('HMHP-111')}`).length === 1,
    JSON.stringify(requests),
  )

  const cards = [...document.querySelectorAll('[data-dsh-jira-card]')].map((node) => node.getAttribute('data-key'))
  check('the looked-up issue becomes a card', cards.includes('HMHP-111'), JSON.stringify(cards))
  // A lookup is an exact question, not a filter over the page: showing the page
  // as well would bury the one issue the user asked for.
  check('the board shows exactly that issue', cards.length === 1, JSON.stringify(cards))

  const drawer = document.body.textContent ?? ''
  check('the drawer opens on the looked-up issue', drawer.includes('从编号直达的工单'), drawer.slice(0, 200))

  // A chip that excludes HMHP must not hide the issue the user asked for.
  const hmhpChip = [...document.querySelectorAll('button[aria-pressed]')].find((node) =>
    (node.textContent ?? '').trim().startsWith('DEMOAPP'),
  )
  if (hmhpChip !== undefined) {
    await act(async () => {
      hmhpChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await flush(4)
    const narrowed = [...document.querySelectorAll('[data-dsh-jira-card]')].map((node) => node.getAttribute('data-key'))
    check('a project chip keeps the looked-up issue visible', narrowed.includes('HMHP-111'), JSON.stringify(narrowed))
  } else {
    check('a project chip was available to narrow the board', false)
  }

  // Escape drops the lookup, so the board goes back to its page with the chip
  // that was clicked still in force.
  await pressEscape(box)
  const afterEscape = [...document.querySelectorAll('[data-dsh-jira-card]')].map((node) => node.getAttribute('data-key'))
  check('Escape puts the looked-up issue away', !afterEscape.includes('HMHP-111'), JSON.stringify(afterEscape))
  check('and the page comes back', afterEscape.includes('DEMOAPP-27') && afterEscape.includes('DEMOAPP-34'), JSON.stringify(afterEscape))
  check('and clears the box', (box.value ?? '') === '', box.value)

  // A pasted Jira link behaves identically: it is the other shape a user has
  // in their clipboard when they want one specific issue.
  await type(box, `https://${SITE}/browse/HMHP-111?atlOrigin=board`)
  await pressEnter(box)
  const viaLink = [...document.querySelectorAll('[data-dsh-jira-card]')].map((node) => node.getAttribute('data-key'))
  check('a pasted browse link resolves to the same issue', viaLink.includes('HMHP-111'), JSON.stringify(viaLink))
  await pressEscape(box)
  await flush(4)

  // A key that does not exist must say so, and must stay retryable.
  failIssue = true
  await type(box, 'HMHP-999')
  await pressEnter(box)
  const failed = document.body.textContent ?? ''
  check('a missing key is reported as not found', failed.includes('找不到 HMHP-999'), failed.slice(0, 240))
  check('a failed lookup adds no card', ![...document.querySelectorAll('[data-dsh-jira-card]')]
    .some((node) => node.getAttribute('data-key') === 'HMHP-999'))
  failIssue = false

  // An envelope with no issue inside is a broken answer, not an issue: it must
  // be reported and must NOT be stored, because a stored one has no key and the
  // next render would throw instead of showing the notice.
  emptyIssue = true
  await type(box, 'HMHP-111')
  await pressEnter(box)
  const empty = document.body.textContent ?? ''
  check('an empty envelope is reported', empty.includes('服务端没有返回工单内容'), empty.slice(0, 240))
  check('an empty envelope leaves the board standing', document.querySelector('[data-dsh-jira-board]') !== null)
  emptyIssue = false
  await pressEscape(box)
  await flush(4)

  // Ordinary text stays an ordinary filter: no lookup, no navigation.
  const before = requests.length
  await type(box, '地址')
  await flush(4)
  const filtered = [...document.querySelectorAll('[data-dsh-jira-card]')].map((node) => node.getAttribute('data-key'))
  check('a plain query still filters the page', filtered.length === 1 && filtered[0] === 'DEMOAPP-34', JSON.stringify(filtered))
  check('a plain query issues no request', requests.length === before, `${String(requests.length - before)} extra`)
}

await act(async () => {
  reactRoot.unmount()
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

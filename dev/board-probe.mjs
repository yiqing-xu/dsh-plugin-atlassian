// Headless UI probe for the Jira board panel.
//
// The host-side checks prove the DATA is right. This proves the panel actually
// renders it: it opens the app, clicks the board's sidebar entry, and asserts on
// the live DOM — cards, columns, the issue drawer, and its controls. It can also
// capture the README screenshot.
//
//   node dev/board-probe.mjs "http://127.0.0.1:43199/?token=..." [--shot assets/jira-board.png]
//
// Start the app first, e.g.
//   dsh --profile atlassian-dev --patch ./dev/overlay-no-browser.yml --port 43199 --no-open

import { sleep, withChrome, reportProblems } from './cdp.mjs'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node dev/board-probe.mjs "<url with token>" [--shot <file>]')
  process.exit(2)
}
const shotIndex = process.argv.indexOf('--shot')
const shotFile = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined

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

/** Status-filter chip label → the `statusCategory.key` its cards must carry. */
const STATUS_CATEGORY = { 待办: 'new', 进行中: 'indeterminate', 完成: 'done' }

await withChrome({ port: 9224 }, async (cdp) => {
  console.log('→ navigating')
  await cdp.send('Page.navigate', { url })
  await sleep(8000)

  // The board is a global panel: its sidebar entry carries the label the plugin
  // registered, and clicking it is the whole navigation story.
  console.log('\nsidebar entry')
  const entry = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button, [role=button], a')]
    const hit = buttons.find((node) => {
      const label = (node.getAttribute('aria-label') || node.textContent || '').trim()
      return label === 'Jira' || label.startsWith('Jira 看板')
    })
    if (!hit) {
      return { found: false, candidates: buttons.map((n) => (n.getAttribute('aria-label') || n.textContent || '').trim()).filter(Boolean).slice(0, 50) }
    }
    hit.click()
    return { found: true, label: (hit.getAttribute('aria-label') || hit.textContent || '').trim() }
  })()`)
  check('board sidebar entry exists', entry.found === true, JSON.stringify(entry.candidates ?? entry))
  console.log(`       label: ${JSON.stringify(entry.label ?? '')}`)

  // Give the panel a moment to mount and finish its first board read.
  await sleep(6000)

  console.log('\npanel')
  const panel = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-dsh-jira-board]')
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    const chips = [...document.querySelectorAll('button[aria-pressed]')]
    const text = root ? root.innerText : ''
    const jql = document.querySelector('input[value*="updated"]')
    return {
      mounted: root !== null,
      cards: cards.length,
      chipLabels: chips.map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim()),
      hasFilterLabels: text.includes('项目') && text.includes('状态'),
      hasAssigneeRow: text.includes('经办人'),
      hasMineChip: chips.some((c) => (c.textContent || '').trim() === '我'),
      hasSearch: !!document.querySelector('input[placeholder*="搜索"]'),
      hasJqlBox: jql !== null,
      text: text.slice(0, 1400),
    }
  })()`)
  check('board panel is mounted', panel.mounted === true)
  check('board rendered issue cards', panel.cards > 0, `cards=${String(panel.cards)}`)
  check('board text mentions connected site', /atlassian\.net|Jira/.test(panel.text), panel.text.slice(0, 120))
  check('project and status filter rows are present', panel.hasFilterLabels === true)
  check('an assignee filter row is present', panel.hasAssigneeRow === true)
  check('the "assigned to me" chip is present', panel.hasMineChip === true)
  check('search box is present', panel.hasSearch === true)
  check('JQL box shows the active query', panel.hasJqlBox === true)
  console.log(`       filter chips: ${panel.chipLabels.join(' | ')}`)

  console.log('\n--- panel text (first 700 chars) ---')
  console.log(panel.text.slice(0, 700))
  console.log('---')

  // Filtering, end to end. A project chip is preferred — it is the axis this
  // feature exists for — but when the active JQL already pins one project there
  // is nothing to narrow by, so the same assertion runs against a status chip
  // instead. Either way the check is that the board really narrowed, and which
  // chip was clicked is reported so the log cannot imply the wrong thing.
  console.log('\nfiltering')
  const filterResult = await cdp.evaluate(`(() => {
    const cardsOf = () => [...document.querySelectorAll('[data-dsh-jira-card]')]
    const total = cardsOf().length
    const chipFor = (label) => [...document.querySelectorAll('button[aria-pressed]')]
      .find((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(label))

    const byProject = new Map()
    for (const card of cardsOf()) {
      const project = card.getAttribute('data-project') || ''
      if (project) byProject.set(project, (byProject.get(project) || 0) + 1)
    }
    const project = [...byProject.entries()].filter(([, n]) => n > 0 && n < total).sort((a, b) => a[1] - b[1])[0]
    if (project && chipFor(project[0])) {
      chipFor(project[0]).click()
      return { applicable: true, kind: 'project', target: project[0], expected: project[1], total }
    }

    const byCategory = new Map()
    for (const card of cardsOf()) {
      const key = card.getAttribute('data-category') || ''
      if (key) byCategory.set(key, (byCategory.get(key) || 0) + 1)
    }
    const wanted = { new: '待办', indeterminate: '进行中', done: '完成' }
    const category = [...byCategory.entries()].filter(([, n]) => n > 0 && n < total).sort((a, b) => a[1] - b[1])[0]
    if (category && chipFor(wanted[category[0]] || '')) {
      chipFor(wanted[category[0]]).click()
      return { applicable: true, kind: 'status', target: wanted[category[0]], expected: category[1], total }
    }
    return { applicable: false, total, reason: 'no chip narrows this board' }
  })()`)
  if (filterResult.applicable !== true) {
    check('a filter chip narrows the board', false, JSON.stringify(filterResult))
  } else {
    await sleep(1200)
    const after = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
      return {
        count: cards.length,
        projects: [...new Set(cards.map((c) => c.getAttribute('data-project')))],
        categories: [...new Set(cards.map((c) => c.getAttribute('data-category')))],
        pressed: [...document.querySelectorAll('button[aria-pressed="true"]')]
          .map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()),
        hasClear: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '清除筛选'),
      }
    })()`)
    check(
      `clicking ${String(filterResult.kind)} "${String(filterResult.target)}" narrowed ${String(filterResult.total)} cards to ${String(filterResult.expected)}`,
      after.count === filterResult.expected,
      `got ${String(after.count)}`,
    )
    const matches =
      filterResult.kind === 'project'
        ? after.projects.length === 1 && after.projects[0] === filterResult.target
        : after.categories.length === 1 && after.categories[0] === STATUS_CATEGORY[filterResult.target]
    check('every remaining card matches the active filter', matches, JSON.stringify({ projects: after.projects, categories: after.categories }))
    check('a clear-filters action appeared', after.hasClear === true)
    console.log(`       active chips: ${after.pressed.join(' | ')}`)

    // Reversible, which is what stops a filter from becoming a trap.
    const cleared = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '清除筛选')
      if (!button) return false
      button.click()
      return true
    })()`)
    await sleep(1200)
    const restored = await cdp.evaluate(`document.querySelectorAll('[data-dsh-jira-card]').length`)
    check(
      'clearing restores every card',
      cleared === true && restored === filterResult.total,
      `cleared=${String(cleared)} count=${String(restored)}`,
    )
  }

  // "Assigned to me": the one filter that is a SERVER-side constraint. The
  // assertion is on the JQL box, because that is what proves the chip reaches
  // the query instead of sifting the page the board happens to hold — and the
  // clause must land BEFORE the trailing ORDER BY or Jira rejects the query.
  console.log('\nassigned to me')
  const mineOn = await cdp.evaluate(`(() => {
    const chip = [...document.querySelectorAll('button[aria-pressed]')]
      .find((b) => (b.textContent || '').trim() === '我')
    if (!chip) return { found: false }
    chip.click()
    return { found: true }
  })()`)
  await sleep(3500)
  const mineState = await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('input')]
      .find((i) => (i.value || '').includes('updated >=') || (i.value || '').includes('currentUser'))
    const chip = [...document.querySelectorAll('button[aria-pressed]')]
      .find((b) => (b.textContent || '').trim() === '我')
    return {
      jql: box ? box.value : null,
      pressed: chip ? chip.getAttribute('aria-pressed') : null,
      cards: document.querySelectorAll('[data-dsh-jira-card]').length,
    }
  })()`)
  if (mineOn.found !== true) {
    check('the "assigned to me" chip is clickable', false, JSON.stringify(mineOn))
  } else {
    check('the chip turns itself on', mineState.pressed === 'true', String(mineState.pressed))
    check(
      'the JQL gains assignee = currentUser()',
      typeof mineState.jql === 'string' && /assignee\\s*=\\s*currentUser\\(\\)/i.test(mineState.jql),
      String(mineState.jql),
    )
    check(
      'the clause lands before ORDER BY',
      typeof mineState.jql === 'string' && !/ORDER BY[^]*assignee\\s*=/i.test(mineState.jql),
      String(mineState.jql),
    )
    console.log(`       jql: ${String(mineState.jql)}`)
    console.log(`       cards: ${String(mineState.cards)}`)

    // Reversible — a filter that cannot be turned off is a trap.
    await cdp.evaluate(`(() => {
      const chip = [...document.querySelectorAll('button[aria-pressed]')]
        .find((b) => (b.textContent || '').trim() === '我')
      if (chip) chip.click()
      return true
    })()`)
    await sleep(3500)
    const mineOff = await cdp.evaluate(`(() => {
      const box = [...document.querySelectorAll('input')]
        .find((i) => (i.value || '').includes('updated >=') || (i.value || '').includes('currentUser'))
      const chip = [...document.querySelectorAll('button[aria-pressed]')]
        .find((b) => (b.textContent || '').trim() === '我')
      return { jql: box ? box.value : null, pressed: chip ? chip.getAttribute('aria-pressed') : null }
    })()`)
    check('turning it off drops the clause again', !/currentUser/i.test(String(mineOff.jql)), String(mineOff.jql))
    check('and the chip unpresses', mineOff.pressed === 'false', String(mineOff.pressed))
  }

  // Multi-select: shift-click extends from the anchor, and a selection bar with
  // batch actions appears. Nothing is dispatched — that would start real agent
  // work in the user's own sessions.
  console.log('\nmulti-select')
  const multi = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    if (cards.length < 3) return { applicable: false, count: cards.length }
    cards[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { applicable: true, start: cards[2].getAttribute('data-key') }
  })()`)
  await sleep(800)

  // Shift-click the fourth card: the range from the third covers 3rd..4th.
  const shifted = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    const target = cards[3]
    if (!target) return { clicked: false }
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    return { clicked: true, key: target.getAttribute('data-key') }
  })()`)
  await sleep(800)
  const selection = await cdp.evaluate(`(() => {
    const bar = document.querySelector('[data-dsh-jira-selection]')
    const checked = [...document.querySelectorAll('[data-dsh-jira-card][data-checked="1"]')]
    return {
      bar: bar !== null,
      checkedKeys: checked.map((c) => c.getAttribute('data-key')),
      buttons: bar ? [...bar.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [],
    }
  })()`)
  if (multi.applicable !== true) {
    check('multi-select is exercisable', false, `only ${String(multi.count)} cards`)
  } else {
    check('shift-click builds a selection of two', selection.checkedKeys.length === 2, JSON.stringify(selection.checkedKeys))
    check('every selected card shows its checkbox', selection.checkedKeys.length > 0)
    check('a selection bar appears', selection.bar === true)
    check('the bar offers batch hand-over', selection.buttons.includes('交给 agent…'), JSON.stringify(selection.buttons))
    check('the bar offers a new session', selection.buttons.includes('新建会话'), JSON.stringify(selection.buttons))
    check('the bar offers copy-prompt', selection.buttons.includes('复制提示词'), JSON.stringify(selection.buttons))
    check('the bar offers to clear the selection', selection.buttons.includes('取消选择'), JSON.stringify(selection.buttons))
  }

  // Right-click menu: the reliable path to a specific workspace or session.
  console.log('\nright-click menu')
  const menu = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-dsh-jira-card]')
    if (!card) return { opened: false }
    const box = card.getBoundingClientRect()
    const opts = { bubbles: true, clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 20) }
    card.dispatchEvent(new MouseEvent('contextmenu', opts))
    return { opened: true, scrollX: window.scrollX, scrollY: window.scrollY }
  })()`)
  await sleep(800)
  const menuState = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-dsh-jira-menu]')
    if (!root) return { present: false }
    const box = root.getBoundingClientRect()
    return {
      present: true,
      items: [...root.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()),
      insideViewport: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
      groups: [...root.querySelectorAll('button')].filter((b) => b.querySelector('span:nth-child(2)')).length,
    }
  })()`)
  check('context menu opens', menuState.present === true, JSON.stringify(menuState))
  check('menu stays inside the viewport', menuState.insideViewport === true, JSON.stringify(menuState))
  check('menu offers a new session', (menuState.items ?? []).includes('新建会话（当前工作区）'), JSON.stringify(menuState.items))
  check('menu offers the current session', (menuState.items ?? []).includes('投到当前会话'), JSON.stringify(menuState.items))
  check('menu offers copy-prompt', (menuState.items ?? []).includes('复制提示词'), JSON.stringify(menuState.items))
  console.log(`       menu items: ${(menuState.items ?? []).join(' | ')}`)

  // Expanding a workspace must reveal its own "new session" entry, which is the
  // per-workspace target the feature exists for.
  const expanded = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-dsh-jira-menu]')
    if (!root) return { ok: false }
    const rows = [...root.querySelectorAll('button')]
    // Workspace rows are the ones carrying a chevron AND a count.
    const candidate = rows.find((b) => (b.textContent || '').includes('▸'))
    if (!candidate) return { ok: false, reason: 'no collapsible workspace row', items: rows.map((b) => (b.textContent || '').trim()) }
    candidate.click()
    return { ok: true, label: (candidate.textContent || '').replace(/\\s+/g, ' ').trim() }
  })()`)
  await sleep(700)
  const expandedState = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-dsh-jira-menu]')
    if (!root) return { present: false }
    const items = [...root.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim())
    return { present: true, items }
  })()`)
  if (expanded.ok === true) {
    check(
      'expanding a workspace reveals a per-workspace new-session entry',
      (expandedState.items ?? []).some((item) => item.startsWith('＋ 新建会话')),
      JSON.stringify(expandedState.items),
    )
    console.log(`       expanded: ${String(expanded.label)}`)
  } else {
    check('a workspace row was expandable', false, JSON.stringify(expanded))
  }

  // Dismissal: the menu must not survive a click elsewhere, or it would act on
  // a card that is no longer in context.
  const dismissed = await cdp.evaluate(`(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  const stillOpen = await cdp.evaluate(`document.querySelector('[data-dsh-jira-menu]') !== null`)
  check('clicking outside dismisses the menu', dismissed === true && stillOpen === false, `stillOpen=${String(stillOpen)}`)

  // The whole point of the menu: pick a workspace, then a session inside it.
  // Set an inert `board.promptTemplate` in the dev overlay before running this,
  // or the dispatched agent will start real work in your own sessions.
  console.log('\ndeliver to a chosen workspace session')
  const delivered = await cdp.evaluate(`(async () => {
    const card = document.querySelector('[data-dsh-jira-card]')
    if (!card) return { ok: false, reason: 'no card' }
    const box = card.getBoundingClientRect()
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(box.left + 20), clientY: Math.round(box.top + 20) }))
    await new Promise((r) => setTimeout(r, 400))
    const root = document.querySelector('[data-dsh-jira-menu]')
    if (!root) return { ok: false, reason: 'no menu' }
    const rows = [...root.querySelectorAll('button')]
    const workspace = rows.find((b) => (b.textContent || '').includes('▸'))
    if (!workspace) return { ok: false, reason: 'no workspace row' }
    workspace.click()
    await new Promise((r) => setTimeout(r, 400))
    const after = [...document.querySelector('[data-dsh-jira-menu]').querySelectorAll('button')]
    const newSession = after.find((b) => (b.textContent || '').trim().startsWith('＋ 新建会话'))
    if (!newSession) return { ok: false, reason: 'no new-session entry' }
    const label = (workspace.textContent || '').replace(/\\s+/g, ' ').trim()
    newSession.click()
    return { ok: true, workspace: label }
  })()`)
  // The confirmation is transient by design (it fades after a few seconds) and
  // delivery itself takes a round trip, so the two are raced: the probe polls
  // for the notice and, having seen it, returns to the board in the same step.
  console.log('\n  waiting for the delivery (polling for the transient notice)')
  let deliveryResult = {
    notices: [],
    menuClosed: false,
    selectionCleared: false,
    inConversation: false,
    composerHasText: false,
    onBoard: false,
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500)
    deliveryResult = await cdp.evaluate(`(() => {
      const body = document.body.innerText
      const banner = [...document.querySelectorAll('div')]
        .map((d) => (d.textContent || '').trim())
        .filter((t) => /已交给新会话|已投递到|投递失败|会话已建好/.test(t) && t.length < 160)
      const entry = [...document.querySelectorAll('button, [role=button], a')]
        .find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim() === 'Jira')
      const onBoard = document.querySelector('[data-dsh-jira-board]') !== null
      return {
        notices: [...new Set(banner)].slice(0, 3),
        menuClosed: document.querySelector('[data-dsh-jira-menu]') === null,
        selectionCleared: document.querySelector('[data-dsh-jira-selection]') === null,
        inConversation: body.includes('这是一条投递链路的验证消息'),
        composerHasText: body.includes('验证消息'),
        onBoard,
        hasEntry: entry !== undefined,
      }
    })()`)
    if (deliveryResult.notices.length > 0) break
  }
  if (delivered.ok !== true) {
    check('a workspace session could be chosen', false, JSON.stringify(delivered))
  } else {
    console.log(`       workspace: ${String(delivered.workspace)}`)
    check('the menu closed after choosing', deliveryResult.menuClosed === true)
    // Delivery itself is evidenced by the prompt reaching the session and the
    // selection clearing. The confirmation banner is additionally reported, but
    // NOT asserted: it is transient by design, and a run whose poll lands
    // outside its lifetime would fail a delivery that actually worked.
    console.log(
      `       confirmation banner: ${deliveryResult.notices.length > 0 ? deliveryResult.notices.join(' / ') : '(not observed)'}`,
    )
    check('the multi-selection was cleared after delivery', deliveryResult.selectionCleared === true)
    check(
      'the delivered prompt reached the session',
      deliveryResult.inConversation === true || deliveryResult.composerHasText === true,
      JSON.stringify(deliveryResult),
    )
    check(
      'the board stayed mounted, so another hand-over is possible',
      deliveryResult.onBoard === true,
      JSON.stringify(deliveryResult),
    )
  }

  // Delivery navigates to the delivered session, so the board has to be brought
  // back before the drawer can be exercised at all.
  console.log('\nreturn to the board')
  const back = await cdp.evaluate(`(() => {
    const entry = [...document.querySelectorAll('button, [role=button], a')]
      .find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim() === 'Jira')
    if (!entry) return false
    entry.click()
    return true
  })()`)
  await sleep(4000)
  const cardCount = await cdp.evaluate(`document.querySelectorAll('[data-dsh-jira-card]').length`)
  check('the board is reachable again', back === true && cardCount > 0, `cards=${String(cardCount)}`)

  // Clear the selection so the drawer assertions below start from a clean state.
  await cdp.evaluate(`(() => {
    const bar = document.querySelector('[data-dsh-jira-selection]')
    const button = bar && [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '取消选择')
    if (button) button.click()
    return true
  })()`)
  await sleep(600)

  // Open the drawer on a card that has a real workflow ahead of it.
  console.log('\ndrawer')
  const opened = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    if (cards.length === 0) return { clicked: false }
    const target = cards.find((c) => (c.innerText || '').includes('开发中')) || cards[0]
    const key = (target.innerText || '').split('\\n')[0].trim()
    target.click()
    return { clicked: true, key }
  })()`)
  check('a card could be selected', opened.clicked === true)
  await sleep(5000)

  const drawer = await cdp.evaluate(`(() => {
    const text = document.body.innerText
    return {
      hasTransitions: text.includes('变更状态'),
      hasDispatch: text.includes('交给 agent'),
      hasCurrent: text.includes('投到当前会话'),
      hasCopy: text.includes('复制提示词'),
      hasDescription: text.includes('描述'),
      text: text.slice(0, 400),
    }
  })()`)
  const transitionButtons = await cdp.evaluate(`(() => {
    const found = []
    for (const button of document.querySelectorAll('button')) {
      const title = button.getAttribute('title') || ''
      if (/^流转 id /.test(title)) found.push((button.textContent || '').trim())
    }
    return found
  })()`)
  check('drawer shows the transition menu', drawer.hasTransitions === true)
  check('drawer offers the transition buttons', transitionButtons.length > 0, `buttons=${JSON.stringify(transitionButtons)}`)
  check('drawer offers hand-over to a new session', drawer.hasDispatch === true)
  check('drawer offers hand-over to the current session', drawer.hasCurrent === true)
  check('drawer offers copy-prompt', drawer.hasCopy === true)
  check('drawer shows the description section', drawer.hasDescription === true)
  if (transitionButtons.length > 0) console.log(`       transitions: ${transitionButtons.join(' · ')}`)

  // No write is performed: applying a transition here would mutate the user's
  // real issue from a test. The write path is covered against a fake server in
  // dev/verify-board.mjs instead.
  console.log('\n(transition buttons are asserted, never clicked — this is live data)')

  if (shotFile !== undefined) {
    const shot = await cdp.screenshot(shotFile)
    console.log(`\nscreenshot: ${shot.file} (${String(shot.width)}x${String(shot.height)} @2x)`)
  }

  reportProblems(cdp)
})

console.log(failures === 0 ? '\nRESULT: board panel RENDERED' : `\nRESULT: ${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

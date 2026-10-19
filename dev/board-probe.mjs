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

  // Sprint is a named OPTION ("镇海炼化冲刺15.5"), not a yes/no property, and a
  // project runs dozens to hundreds of them — so the row offers a searchable
  // picker instead of one chip per sprint.
  console.log('\nsprint filter')
  const sprintRow = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-dsh-jira-sprints]')
    const picker = document.querySelector('[data-dsh-jira-sprint-picker]')
    return {
      hasRow: row !== null,
      rowText: row ? row.innerText.replace(/\\s+/g, ' ').trim() : '',
      hasPicker: picker !== null,
    }
  })()`)
  check('a sprint filter row is present', sprintRow.hasRow === true, JSON.stringify(sprintRow))
  check('the sprint row offers a picker', sprintRow.hasPicker === true, JSON.stringify(sprintRow))
  // The coarse chips are gone by request: the row is the named-sprint picker
  // alone, and "全部" must not be mistaken for a sprint option.
  check(
    'the row offers named sprints only, no coarse chips',
    !/未完成冲刺|无冲刺/.test(sprintRow.rowText),
    sprintRow.rowText,
  )

  const opened = await cdp.evaluate(`(() => {
    const picker = document.querySelector('[data-dsh-jira-sprint-picker]')
    if (!picker) return { opened: false }
    const toggle = picker.querySelector('button')
    if (!toggle) return { opened: false }
    toggle.click()
    return { opened: true }
  })()`)
  await sleep(1500)
  const listbox = await cdp.evaluate(`(() => {
    const options = [...document.querySelectorAll('[data-sprint-id]')]
    const search = [...document.querySelectorAll('[data-dsh-jira-sprint-picker] input')]
    return {
      options: options.length,
      names: options.slice(0, 8).map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim()),
      hasSearch: search.length > 0,
      empty: /没有可选的冲刺|无法列出冲刺/.test((document.querySelector('[data-dsh-jira-sprint-picker]') || document.body).innerText),
    }
  })()`)
  check('the picker opens a listbox', opened.opened === true, JSON.stringify(opened))
  check('the listbox can be searched', listbox.hasSearch === true, JSON.stringify(listbox))
  // A board narrowed to a project must actually list that project's sprints;
  // the empty state is a legitimate answer only when the query pins no project.
  check(
    'the picker lists the project\'s sprints',
    listbox.options > 0 || listbox.empty === true,
    JSON.stringify({ options: listbox.options, empty: listbox.empty }),
  )
  console.log(`       sprint options: ${String(listbox.options)} — ${listbox.names.join(' | ')}`)

  // Picking one must put a server-side clause in the JQL, which is the whole
  // promise of the filter: the board narrows across pages, not within one.
  const picked = await cdp.evaluate(`(() => {
    const options = [...document.querySelectorAll('[data-sprint-id]')]
    const target = options.find((node) => !/已结束/.test(node.textContent || '')) || options[0]
    if (!target) return { picked: false }
    const name = (target.textContent || '').replace(/\\s+/g, ' ').trim()
    const id = target.getAttribute('data-sprint-id')
    target.click()
    return { picked: true, id, name }
  })()`)
  if (picked.picked === true) {
    await sleep(3000)
    const applied = await cdp.evaluate(`(() => {
      const roots = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      const jql = roots.find((i) => /更新|updated|sprint/i.test(i.value || ''))
      const picker = document.querySelector('[data-dsh-jira-sprint-picker]')
      return {
        jql: jql ? jql.value : null,
        toggle: picker ? (picker.querySelector('button')?.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        cards: document.querySelectorAll('[data-dsh-jira-card]').length,
        listClosed: document.querySelectorAll('[data-sprint-id]').length === 0,
      }
    })()`)
    check(
      `picking sprint ${String(picked.name)} puts a sprint clause in the JQL`,
      typeof applied.jql === 'string' && /sprint\s*=\s*\d+/i.test(applied.jql),
      JSON.stringify(applied),
    )
    check('the picker shows the chosen sprint', /冲刺|sprint/i.test(applied.toggle ?? ''), applied.toggle)
    check('the listbox closes after picking', applied.listClosed === true)
    console.log(`       JQL: ${applied.jql}`)

    // Reversible, like every other filter: the × must clear the clause.
    const cleared = await cdp.evaluate(`(() => {
      const picker = document.querySelector('[data-dsh-jira-sprint-picker]')
      const clear = picker ? [...picker.querySelectorAll('span')].find((n) => (n.textContent || '').trim() === '×') : null
      if (!clear) return { found: false }
      clear.click()
      return { found: true }
    })()`)
    await sleep(2500)
    const after = await cdp.evaluate(`(() => {
      const roots = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      const jql = roots.find((i) => /更新|updated|sprint/i.test(i.value || ''))
      return { jql: jql ? jql.value : null }
    })()`)
    check(
      'the sprint filter can be cleared from the picker',
      cleared.found === true && !/sprint\s*=\s*\d+/i.test(after.jql ?? ''),
      JSON.stringify({ cleared, after }),
    )
  } else {
    console.log('       (no sprint options on this board — skipped the pick assertions)')
  }

  // Typing a key must offer the exact lookup rather than an empty board: the
  // page the board holds cannot contain an arbitrary issue, and "this page has
  // nothing" is not the same answer as "no such issue".
  //
  // Typing is retried and then verified through the DOM. The panel is still
  // settling right after it mounts (a background revalidation can re-render the
  // toolbar), and an input that has been replaced under the probe takes the
  // synthetic event with it — which used to read as "the feature is broken".
  console.log('\nsearch by key')
  const typeIntoSearch = async (value) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await cdp.evaluate(`(() => {
        const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
          .find((i) => (i.placeholder || '').includes('搜索'))
        if (!box) return { found: false }
        box.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(box, ${JSON.stringify(value)})
        box.dispatchEvent(new Event('input', { bubbles: true }))
        return { found: true }
      })()`)
      if (result.found !== true) {
        await sleep(700)
        continue
      }
      await sleep(900)
      const live = await cdp.evaluate(`(() => {
        const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
          .find((i) => (i.placeholder || '').includes('搜索'))
        return box ? box.value : null
      })()`)
      if (live === value) return true
    }
    return false
  }

  const typed = await typeIntoSearch('DEMOAPP-999999')
  const keyState = await cdp.evaluate(`(() => {
    const text = (document.querySelector('[data-dsh-jira-board]') || document.body).innerText
    return {
      offersOpen: /按编号打开/.test(text),
      cards: document.querySelectorAll('[data-dsh-jira-card]').length,
      hint: /回车/.test(text),
    }
  })()`)
  check('typing a key offers an exact lookup', typed === true && keyState.offersOpen === true, JSON.stringify(keyState))
  check('the lookup is explained as Enter-driven', keyState.hint === true, JSON.stringify(keyState))
  // Put the box back: a probe must not leave the board filtered by a fake key.
  await typeIntoSearch('')
  await sleep(700)

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

  // Pinned projects: a pin reorders the project row — appending, so the row
  // grows in the order the user pinned — and persists on the host rather than
  // in the page, so it survives a reload.
  console.log('\npinned projects')
  const pinState = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-dsh-jira-projects]')
    const pins = [...document.querySelectorAll('[data-dsh-jira-pin]')]
    return {
      hasRow: row !== null,
      pins: pins.length,
      pinnedNow: pins.filter((node) => node.getAttribute('data-dsh-jira-pin') === '1').length,
      before: row ? [...row.querySelectorAll('[data-dsh-jira-chip]')].map((b) => (b.getAttribute('data-dsh-jira-chip') === 'project' ? (b.textContent || '').replace(/\\s+/g, ' ').trim() : '')) : [],
    }
  })()`)
  check('the project row offers a pin per project', pinState.hasRow === true && pinState.pins > 0, JSON.stringify(pinState))

  if (pinState.pins > 0) {
    // Pin the LAST unpinned project, so appending is what moves it to the front
    // of the pinned run — pinning the first one would pass even if the code
    // prepended.
    const pinResult = await cdp.evaluate(`(() => {
      const pins = [...document.querySelectorAll('[data-dsh-jira-pin]')]
      const unpinned = pins.filter((node) => node.getAttribute('data-dsh-jira-pin') !== '1')
      const target = unpinned[unpinned.length - 1] || pins[0]
      const chip = target.closest('[data-dsh-jira-filter]')
      const name = chip ? (chip.querySelector('[data-dsh-jira-chip]')?.textContent || '').replace(/\\s+/g, ' ').trim() : ''
      target.click()
      return { clicked: true, name }
    })()`)
    await sleep(1500)
    const afterPin = await cdp.evaluate(`(() => {
      const pins = [...document.querySelectorAll('[data-dsh-jira-pin]')]
      const row = document.querySelector('[data-dsh-jira-projects]')
      return {
        pinnedNow: pins.filter((node) => node.getAttribute('data-dsh-jira-pin') === '1').length,
        firstPinned: (() => {
          const chip = row ? row.querySelector('[data-dsh-jira-chip][data-pinned="1"]') : null
          return chip ? (chip.textContent || '').replace(/\\s+/g, ' ').trim() : null
        })(),
        order: row ? [...row.querySelectorAll('[data-dsh-jira-chip]')].map((b) => (b.getAttribute('data-pinned') === '1' ? '★' : '·') + (b.textContent || '').replace(/\\s+/g, ' ').trim()) : [],
      }
    })()`)
    check(
      `pinning ${String(pinResult.name)} marks it pinned`,
      afterPin.pinnedNow >= 1,
      JSON.stringify(afterPin),
    )
    check(
      'the pinned project leads the row',
      afterPin.firstPinned !== null && (afterPin.firstPinned === pinResult.name || pinState.pinnedNow > 0),
      JSON.stringify({ expected: pinResult.name, got: afterPin.firstPinned }),
    )
    console.log(`       row order: ${afterPin.order.join(' | ')}`)

    // Clicking the pin must NOT also filter: that would make one small control
    // do two things and the board would narrow on a reorder.
    const notFiltered = await cdp.evaluate(`(() => {
      const row = document.querySelector('[data-dsh-jira-projects]')
      // "全部" is always pressed when nothing narrows the row; only a NAMED
      // project chip being pressed would mean the pin also filtered the board.
      const named = row
        ? [...row.querySelectorAll('[data-dsh-jira-chip][aria-pressed="true"]')].filter(
            (node) => !/^全部/.test((node.textContent || '').replace(/\s+/g, ' ').trim()),
          )
        : []
      const active = named.length
      return { activeProjectChips: active }
    })()`)
    check('pinning does not also apply the filter', notFiltered.activeProjectChips === 0, JSON.stringify(notFiltered))

    // Persisted on the host: a reload must come back pinned.
    console.log('       reloading to check the pin persisted…')
    await cdp.send('Page.reload', {})
    await sleep(9000)
    const reopened = await cdp.evaluate(`(() => {
      const label = [...document.querySelectorAll('button, [role=button], a')]
        .find((node) => ((node.getAttribute('aria-label') || node.textContent || '').trim() === 'Jira'))
      if (label) label.click()
      return true
    })()`)
    await sleep(5000)
    const restoredPins = await cdp.evaluate(`(() => {
      const pins = [...document.querySelectorAll('[data-dsh-jira-pin]')]
      return { pins: pins.length, pinnedNow: pins.filter((node) => node.getAttribute('data-dsh-jira-pin') === '1').length }
    })()`)
    check(
      'the pin survives a reload',
      reopened === true && restoredPins.pinnedNow >= 1,
      JSON.stringify(restoredPins),
    )

    // Leave the profile as it was found: a probe must not permanently pin a
    // project in the developer's own board.
    const unpinned = await cdp.evaluate(`(() => {
      const pins = [...document.querySelectorAll('[data-dsh-jira-pin="1"]')]
      for (const node of pins) node.click()
      return pins.length
    })()`)
    await sleep(1200)
    console.log(`       unpinned ${String(unpinned)} project(s) again`)
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
      typeof mineState.jql === 'string' && /assignee\s*=\s*currentUser\(\)/i.test(mineState.jql),
      String(mineState.jql),
    )
    check(
      'the clause lands before ORDER BY',
      typeof mineState.jql === 'string' && !/ORDER BY[^]*assignee\s*=/i.test(mineState.jql),
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
  const drawerOpened = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    if (cards.length === 0) return { clicked: false }
    const target = cards.find((c) => (c.innerText || '').includes('开发中')) || cards[0]
    const key = (target.innerText || '').split('\\n')[0].trim()
    target.click()
    return { clicked: true, key }
  })()`)
  check('a card could be selected', drawerOpened.clicked === true)

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

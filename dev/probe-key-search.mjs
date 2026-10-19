// Focused CDP check for the search-by-key path, against a live dev profile.
//
//   node dev/probe-key-search.mjs "http://127.0.0.1:43199/?token=..." [KEY]
//
// It types a real key into the search box, asserts the board offers/executes the
// lookup, and prints the resulting cards. It never writes to Jira.

import { sleep, withChrome, reportProblems } from './cdp.mjs'

const url = process.argv[2]
const key = process.argv[3] ?? 'HMHP-111'
if (url === undefined) {
  console.error('usage: node dev/probe-key-search.mjs "<url with token>" [KEY]')
  process.exit(2)
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

await withChrome({ port: 9225 }, async (cdp) => {
  await cdp.send('Page.navigate', { url })
  await sleep(9000)

  const opened = await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button, [role=button], a')]
      .find((node) => ((node.getAttribute('aria-label') || node.textContent || '').trim() === 'Jira'))
    if (!hit) return false
    hit.click()
    return true
  })()`)
  check('board opened', opened === true)
  await sleep(7000)

  const info = await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    return {
      found: !!box,
      placeholder: box ? box.placeholder : null,
      cards: document.querySelectorAll('[data-dsh-jira-card]').length,
    }
  })()`)
  check('search box found', info.found === true, JSON.stringify(info))
  console.log(`       placeholder: ${JSON.stringify(info.placeholder)} · cards: ${String(info.cards)}`)

  // Type, then report what the component did with it.
  const typed = await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    if (!box) return { ok: false }
    box.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(box, ${JSON.stringify(key)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, value: box.value }
  })()`)
  await sleep(1200)
  const state = await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    const text = (document.querySelector('[data-dsh-jira-board]') || document.body).innerText
    return {
      value: box ? box.value : null,
      cards: [...document.querySelectorAll('[data-dsh-jira-card]')].map((c) => c.getAttribute('data-key')),
      offersOpen: /按编号打开/.test(text),
      saysEnter: /回车/.test(text),
      text: text.slice(0, 600),
    }
  })()`)
  console.log(`       typed=${JSON.stringify(typed.value)} value=${JSON.stringify(state.value)}`)
  console.log(`       cards=${JSON.stringify(state.cards)} offersOpen=${String(state.offersOpen)} enter=${String(state.saysEnter)}`)
  check('the input value stuck', state.value === key, JSON.stringify(state))
  check('typing narrows the board (so the event reached React)', state.cards.length === 0 || state.offersOpen === true, JSON.stringify(state.cards))

  // Enter: the exact lookup.
  await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(6000)
  const after = await cdp.evaluate(`(() => {
    const text = (document.querySelector('[data-dsh-jira-board]') || document.body).innerText
    const cards = [...document.querySelectorAll('[data-dsh-jira-card]')]
    return {
      cards: cards.map((c) => c.getAttribute('data-key')),
      summaries: cards.map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
      drawer: text.includes('变更状态') || text.includes('在 Jira 打开'),
      text: text.slice(0, 500),
    }
  })()`)
  console.log(`       after Enter: cards=${JSON.stringify(after.cards)}`)
  console.log(`       drawer open: ${String(after.drawer)}`)
  check('the lookup produced exactly that issue', after.cards.length === 1 && after.cards[0] === key, JSON.stringify(after.cards))
  check('the drawer opened on it', after.drawer === true, after.text)

  // Escape restores the page.
  await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await sleep(1500)
  const restored = await cdp.evaluate(`(() => ({
    value: [...document.querySelectorAll('[data-dsh-jira-board] input')].find((i) => (i.placeholder || '').includes('搜索')).value,
    cards: document.querySelectorAll('[data-dsh-jira-card]').length,
  }))()`)
  check('Escape restores the page', restored.cards > 1, JSON.stringify(restored))
  check('Escape clears the box', restored.value === '', JSON.stringify(restored))

  reportProblems(cdp)
})

console.log(failures === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${String(failures)} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

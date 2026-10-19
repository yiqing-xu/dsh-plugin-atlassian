// Captures the two states of the search box for visual review.
//
//   node dev/probe-key-search-shot.mjs "http://127.0.0.1:43199/?token=..." [KEY]
//
// Writes assets/probe-key-prompt.png (the exact-lookup prompt) and
// assets/probe-key-open.png (the by-key issue with its drawer). These are
// DIAGNOSTIC shots for the developer — they are not redacted, so they must not be
// published; README images go through `capture-screenshots.mjs`.

import { mkdir } from 'node:fs/promises'
import { sleep, withChrome, reportProblems } from './cdp.mjs'

const url = process.argv[2]
const key = process.argv[3] ?? 'HMHP-111'
if (url === undefined) {
  console.error('usage: node dev/probe-key-search-shot.mjs "<url with token>" [KEY]')
  process.exit(2)
}

await mkdir('assets', { recursive: true })

await withChrome({ port: 9226 }, async (cdp) => {
  await cdp.send('Page.navigate', { url })
  await sleep(9000)
  await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button, [role=button], a')]
      .find((node) => ((node.getAttribute('aria-label') || node.textContent || '').trim() === 'Jira'))
    if (hit) hit.click()
    return true
  })()`)
  await sleep(7000)

  // A fresh profile opens the "preview" notice over the board; dismiss it or
  // every screenshot is a picture of that dialog.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dismissed = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === '继续')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (dismissed !== true) break
    await sleep(800)
  }
  await sleep(600)

  const type = async (value) => {
    await cdp.evaluate(`(() => {
      const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
        .find((i) => (i.placeholder || '').includes('搜索'))
      box.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(box, ${JSON.stringify(value)})
      box.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
  }

  await type(key)
  const prompt = await cdp.screenshot('assets/probe-key-prompt.png')
  console.log(`  → ${prompt.file} (${String(prompt.width)}x${String(prompt.height)})`)

  await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('[data-dsh-jira-board] input')]
      .find((i) => (i.placeholder || '').includes('搜索'))
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(6000)
  const open = await cdp.screenshot('assets/probe-key-open.png')
  console.log(`  → ${open.file} (${String(open.width)}x${String(open.height)})`)

  reportProblems(cdp)
})

// Exercises the UI preferences document and its HTTP surface.
//
// The sidebar switch is the only writer, and it must be trustworthy across
// restarts: hiding the Jira panel is a persistent choice, not a per-tab toggle.
// This harness covers the store (defaults, round-trip, corrupt input,
// serialized writes) and the `/prefs` endpoints the Settings page calls,
// including the rejection of a non-boolean value.
//
// Run with: node dev/verify-prefs.mjs

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreferenceStore, preferencesFileFor } from '../lib/prefs.js'
import { registerRoutes, ROUTE_PREFIX } from '../lib/routes.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-atlassian-prefs-'))

try {
  console.log('defaults')
  const file = join(directory, 'prefs.json')
  const store = new PreferenceStore(file)
  const initial = await store.load()
  check('a fresh profile shows the panel', initial.panelVisible === true)
  check('the default is what current reports', store.current.panelVisible === true)

  console.log('\nround trip')
  const hidden = await store.patch({ panelVisible: false })
  check('the write returns the stored value', hidden.panelVisible === false)
  const written = JSON.parse(await readFile(file, 'utf8'))
  check('the document is on disk', written.panelVisible === false, JSON.stringify(written))

  const reopened = new PreferenceStore(file)
  const reloaded = await reopened.load()
  check('a new store sees the persisted value', reloaded.panelVisible === false)

  const shown = await reopened.patch({ panelVisible: true })
  check('the value can be turned back on', shown.panelVisible === true)

  console.log('\nserialized writes')
  const raced = new PreferenceStore(join(directory, 'raced.json'))
  await Promise.all([raced.patch({ panelVisible: false }), raced.patch({ panelVisible: true })])
  check('both writes finish', raced.current.panelVisible === true)
  const racedOnDisk = JSON.parse(await readFile(join(directory, 'raced.json'), 'utf8'))
  check('disk matches the last write', racedOnDisk.panelVisible === true, JSON.stringify(racedOnDisk))

  // Pinned projects: the ARRAY ORDER is the pin order, so every normalizing rule
  // below exists to keep that order meaningful across reloads.
  console.log('\npinned projects')
  const pins = new PreferenceStore(join(directory, 'pins.json'))
  const fresh = await pins.load()
  check('a fresh profile pins nothing', Array.isArray(fresh.pinnedProjects) && fresh.pinnedProjects.length === 0)

  const onePin = await pins.patch({ pinnedProjects: ['PICDLY'] })
  check('a pin is stored', onePin.pinnedProjects.join(',') === 'PICDLY', JSON.stringify(onePin.pinnedProjects))

  const twoPins = await pins.patch({ pinnedProjects: ['PICDLY', 'HMHP'] })
  check('a second pin appends', twoPins.pinnedProjects.join(',') === 'PICDLY,HMHP', JSON.stringify(twoPins.pinnedProjects))

  const reopenedPins = new PreferenceStore(join(directory, 'pins.json'))
  check(
    'the pin order survives a reload',
    (await reopenedPins.load()).pinnedProjects.join(',') === 'PICDLY,HMHP',
    JSON.stringify((await reopenedPins.load()).pinnedProjects),
  )

  const normalized = await pins.patch({ pinnedProjects: ['picdly', 'PICDLY', 'hmhp', '  ', 'x y', 42] })
  check(
    'keys are upper-cased, de-duplicated and filtered',
    normalized.pinnedProjects.join(',') === 'PICDLY,HMHP',
    JSON.stringify(normalized.pinnedProjects),
  )

  const pinnedFile = JSON.parse(await readFile(join(directory, 'pins.json'), 'utf8'))
  check(
    'the normalized list is what lands on disk',
    pinnedFile.pinnedProjects.join(',') === 'PICDLY,HMHP',
    JSON.stringify(pinnedFile.pinnedProjects),
  )

  const halfWrite = await pins.patch({ panelVisible: false })
  check('one field can be patched alone', halfWrite.panelVisible === false)
  check(
    'the other field is kept by a partial patch',
    halfWrite.pinnedProjects.join(',') === 'PICDLY,HMHP',
    JSON.stringify(halfWrite.pinnedProjects),
  )
  await pins.patch({ panelVisible: true })

  const pinsWrongShape = join(directory, 'pins-wrong.json')
  await writeFile(pinsWrongShape, JSON.stringify({ pinnedProjects: 'PICDLY' }), 'utf8')
  check(
    'a non-array pinned field falls back to empty',
    (await new PreferenceStore(pinsWrongShape).load()).pinnedProjects.length === 0,
  )

  console.log('\nuntrusted document')
  const broken = join(directory, 'broken.json')
  await writeFile(broken, '{ this is not json', 'utf8')
  check('a corrupt file falls back to visible', (await new PreferenceStore(broken).load()).panelVisible === true)

  const wrongType = join(directory, 'wrong.json')
  await writeFile(wrongType, JSON.stringify({ panelVisible: 'no' }), 'utf8')
  check('a non-boolean field falls back to visible', (await new PreferenceStore(wrongType).load()).panelVisible === true)

  const boolOnly = join(directory, 'false.json')
  await writeFile(boolOnly, JSON.stringify({ panelVisible: false }), 'utf8')
  check('an explicit false is honoured', (await new PreferenceStore(boolOnly).load()).panelVisible === false)

  console.log('\nfile location')
  const previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = join(directory, 'home')
  try {
    const located = preferencesFileFor('atlassian')
    check('lives under the harness home', located === join(directory, 'home', '.dsh-atlassian', 'atlassian-prefs.json'), located)
  } finally {
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
  }

  console.log('\nprefs endpoint')
  let handler
  const routes = new PreferenceStore(join(directory, 'routes.json'))
  registerRoutes(
    {
      register(route) {
        handler = route.handler
        return () => undefined
      },
    },
    {},
    {},
    { jql: '', limit: 50, timeoutMs: 5000, promptTemplate: '', sprintField: '' },
    routes,
    undefined,
  )

  const call = async (method, path, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: `${ROUTE_PREFIX}${path}`,
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(payload) {
        this.body = payload
      },
    }
    await handler(req, res)
    return { status: res.statusCode, json: res.body === undefined ? undefined : JSON.parse(res.body) }
  }

  const read = await call('GET', '/prefs')
  check('GET answers 200', read.status === 200, String(read.status))
  check('GET starts from the default', read.json?.prefs?.panelVisible === true, JSON.stringify(read.json))

  const hide = await call('POST', '/prefs', { panelVisible: false })
  check('POST answers 200', hide.status === 200, String(hide.status))
  check('POST returns the stored value', hide.json?.prefs?.panelVisible === false, JSON.stringify(hide.json))

  const after = await call('GET', '/prefs')
  check('a later GET reflects the write', after.json?.prefs?.panelVisible === false, JSON.stringify(after.json))

  const invalid = await call('POST', '/prefs', { panelVisible: 'false' })
  check('a non-boolean write is rejected', invalid.status === 400, String(invalid.status))
  check('the rejection names the field', invalid.json?.code === 'bad-request', JSON.stringify(invalid.json))
  check('the stored value was not coerced', (await routes.load()).panelVisible === false)

  const missing = await call('POST', '/prefs', {})
  check('an empty body is rejected', missing.status === 400, String(missing.status))

  // Pinned projects go through the same endpoint, and the ORDER the browser
  // sends is the order stored: pinning appends, so the response must read back
  // the list it was given.
  const pinWrite = await call('POST', '/prefs', { pinnedProjects: ['PICDLY', 'HMHP'] })
  check('a pinned list is accepted', pinWrite.status === 200, String(pinWrite.status))
  check(
    'the pin order is echoed back',
    pinWrite.json?.prefs?.pinnedProjects?.join(',') === 'PICDLY,HMHP',
    JSON.stringify(pinWrite.json),
  )
  check(
    'a pin write leaves the panel switch alone',
    pinWrite.json?.prefs?.panelVisible === false,
    JSON.stringify(pinWrite.json),
  )

  const pinAfter = await call('GET', '/prefs')
  check(
    'a later GET reflects the pins',
    pinAfter.json?.prefs?.pinnedProjects?.join(',') === 'PICDLY,HMHP',
    JSON.stringify(pinAfter.json),
  )

  const unpin = await call('POST', '/prefs', { pinnedProjects: ['HMHP'] })
  check(
    'a pin can be removed',
    unpin.json?.prefs?.pinnedProjects?.join(',') === 'HMHP',
    JSON.stringify(unpin.json),
  )

  const pinsNotArray = await call('POST', '/prefs', { pinnedProjects: 'PICDLY' })
  check('a non-array pin write is rejected', pinsNotArray.status === 400, String(pinsNotArray.status))

  const pinsNotStrings = await call('POST', '/prefs', { pinnedProjects: ['PICDLY', 7] })
  check('a non-string entry is rejected', pinsNotStrings.status === 400, String(pinsNotStrings.status))

  // The recent list is the row's "where was I" strip. Its order is newest-first
  // and it is bounded, because a site with 148 projects must not turn the strip
  // back into the wall it replaces.
  const recentWrite = await call('POST', '/prefs', { recentProjects: ['HMHP', 'PICDLY'] })
  check('a recent list is accepted', recentWrite.status === 200, String(recentWrite.status))
  check(
    'the recent order is echoed back',
    recentWrite.json?.prefs?.recentProjects?.join(',') === 'HMHP,PICDLY',
    JSON.stringify(recentWrite.json),
  )
  check(
    'a recent write leaves the pins alone',
    recentWrite.json?.prefs?.pinnedProjects?.join(',') === 'HMHP',
    JSON.stringify(recentWrite.json),
  )
  const recentAfter = await call('GET', '/prefs')
  check(
    'a later GET reflects the recents',
    recentAfter.json?.prefs?.recentProjects?.join(',') === 'HMHP,PICDLY',
    JSON.stringify(recentAfter.json),
  )
  const recentCapped = await call('POST', '/prefs', {
    recentProjects: Array.from({ length: 20 }, (_, index) => `P${String(index)}`),
  })
  check(
    'the recent strip is capped',
    recentCapped.json?.prefs?.recentProjects?.length === 8,
    String(recentCapped.json?.prefs?.recentProjects?.length),
  )
  const recentNotArray = await call('POST', '/prefs', { recentProjects: 'HMHP' })
  check('a non-array recent write is rejected', recentNotArray.status === 400, String(recentNotArray.status))
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

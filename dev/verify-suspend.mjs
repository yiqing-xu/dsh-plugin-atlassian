// Proves 断开连接 suspends instead of signing out: the tools leave the model's
// context, the authorization stays on disk, and the next connect re-registers
// them without a browser round-trip. Sign-out is a separate action (`forget`),
// and a suspension survives a restart without resurrecting the tools.
//
// One fake MCP server with a seeded authorization; no browser is involved, so
// every assertion here is about state, not about the OAuth flow.
//
// Run with: node dev/verify-suspend.mjs

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AtlassianBridge } from '../lib/bridge.js'
import { registerRoutes, ROUTE_PREFIX } from '../lib/routes.js'
import { PreferenceStore } from '../lib/prefs.js'
import { SessionStore } from '../lib/store.js'

const SITE = 'suspend.example.atlassian.net'
const TOOLS = ['getAccessibleAtlassianResources', 'getJiraIssue', 'searchJiraIssuesUsingJql']

let mcpRequests = 0

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function buildServer() {
  const server = new McpServer({ name: 'suspend-test', version: '1.0.0' })
  for (const name of TOOLS) {
    server.tool(name, `Description of ${name}`, async () => ({
      content: [
        {
          type: 'text',
          text:
            name === 'getAccessibleAtlassianResources'
              ? JSON.stringify({
                  data: {
                    resources: [{ cloudId: '00000000-0000-4000-8000-000000000000', url: `https://${SITE}` }],
                  },
                })
              : JSON.stringify({ data: { tool: name } }),
        },
      ],
    }))
  }
  return server
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname === '/mcp') {
    mcpRequests += 1
    void (async () => {
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(req, res, await readJson(req))
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error))
    })
    return
  }
  const port = httpServer.address().port
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`http://127.0.0.1:${port}/auth`] }))
    return
  }
  if (url.pathname.startsWith('/.well-known/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        issuer: `http://127.0.0.1:${port}/auth`,
        authorization_endpoint: `http://127.0.0.1:${port}/auth/authorize`,
        token_endpoint: `http://127.0.0.1:${port}/auth/token`,
        registration_endpoint: `http://127.0.0.1:${port}/auth/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
    )
    return
  }
  res.writeHead(405)
  res.end()
})

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port
const origin = `http://127.0.0.1:${port}`
// Reserve a port for the OAuth callback, then release it: every bridge here must
// bind the SAME one, because the redirect URI is baked into the stored client
// registration. Production pins `redirectPort` for exactly this reason — a
// restart on a different port deliberately discards the stored tokens, which
// would leave the suspension nothing to resume from.
const redirectPort = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port
    probe.close(() => resolve(assigned))
  })
})

const directory = await mkdtemp(join(tmpdir(), 'dsh-atlassian-suspend-'))
const store = new SessionStore(join(directory, 'session.json'))
await store.patch({
  clientInformation: { client_id: 'suspend-client', redirect_uris: [`${origin}/callback`], issuer: `${origin}/auth` },
  tokens: {
    access_token: 'access-token',
    token_type: 'Bearer',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    issuer: `${origin}/auth`,
  },
})

const registered = new Map()
const logs = []
function makeBridge() {
  return new AtlassianBridge(
    {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
      logger: {
        info: (message) => logs.push(`info ${message}`),
        warn: (message) => logs.push(`warn ${message}`),
        error: (message) => logs.push(`error ${message}`),
      },
    },
    {
      serverName: 'suspend',
      url: `${origin}/mcp`,
      boardUrl: `${origin}/mcp`,
      redirectPort,
      toolCallTimeoutMs: 5000,
      expectedSite: '',
      authorizationTimeoutMs: 5000,
      autoOpenBrowser: false,
      store,
    },
  )
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

let active = makeBridge()
try {
  console.log('connect')
  await active.start()
  check('connects with the seeded authorization', active.snapshot().status === 'ready', active.snapshot().status)
  check('registers every tool', active.snapshot().toolCount === TOOLS.length, String(active.snapshot().toolCount))
  check('reports the authorization', active.snapshot().authorized === true)

  console.log('\n断开连接 suspends')
  const suspended = await active.disconnect()
  check('status is disconnected, not idle', suspended.status === 'disconnected', suspended.status)
  check('unregisters every tool', suspended.toolCount === 0, String(suspended.toolCount))
  check('the registry is actually empty', registered.size === 0, [...registered.keys()].join(','))
  check('forgets the tool catalogue', active.tools().length === 0, String(active.tools().length))
  check('keeps the tokens', (await store.load()).tokens !== undefined)
  check('keeps the authorization flag', suspended.authorized === true)
  check('persists the suspension', (await store.load()).suspended === true)
  check('keeps the site label', suspended.site === SITE, String(suspended.site))
  check('has no authorization URL to offer', suspended.authorizationUrl === undefined)
  check('does not report an error', suspended.error === undefined, String(suspended.error))

  const boardFailure = await (async () => {
    try {
      await active.callTool('getJiraIssue', { issueIdOrKey: 'X-1' })
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  check('refuses a board tool while suspended', boardFailure !== undefined, String(boardFailure))
  check('points at the connection, not a permission', /未连接|设置/.test(String(boardFailure)), String(boardFailure))

  console.log('\n重新连接 resumes without a browser')
  const resumed = await active.authorize()
  check('returns to ready', resumed.status === 'ready', resumed.status)
  check('re-registers every tool', resumed.toolCount === TOOLS.length, String(resumed.toolCount))
  check('the registry is repopulated', registered.size === TOOLS.length, [...registered.keys()].join(','))
  check('clears the persisted suspension', (await store.load()).suspended === undefined)
  check('never published an authorization URL', resumed.authorizationUrl === undefined)
  check('never asked the user to authorize', !logs.some((line) => line.includes('authorization required')), logs.join(' | '))

  console.log('\na suspension survives a restart')
  await active.disconnect()
  // The callback port is single-occupancy, so the old bridge has to let go of
  // it before the "restarted" one can bind the same URI.
  await active.dispose()
  active = makeBridge()
  await active.start()
  check('starts suspended', active.snapshot().status === 'disconnected', active.snapshot().status)
  check('registers nothing on activation', active.snapshot().toolCount === 0, String(active.snapshot().toolCount))
  check('the registry is still empty', registered.size === 0, [...registered.keys()].join(','))
  check('still knows it is authorized', active.snapshot().authorized === true)
  await active.authorize()
  check('resumes on demand', active.snapshot().status === 'ready', active.snapshot().status)
  check('registers the tools again', active.snapshot().toolCount === TOOLS.length, String(active.snapshot().toolCount))

  console.log('\n退出登录 forgets the authorization')
  const forgotten = await active.forget()
  check('returns to idle', forgotten.status === 'idle', forgotten.status)
  check('unregisters every tool', forgotten.toolCount === 0, String(forgotten.toolCount))
  check('drops the tokens', (await store.load()).tokens === undefined)
  check('drops the client registration', (await store.load()).clientInformation === undefined)
  check('no longer claims an authorization', forgotten.authorized === false)
  check('drops the suspension flag too', (await store.load()).suspended === undefined)

  console.log('\nendpoints')
  let handler
  registerRoutes(
    {
      register(route) {
        handler = route.handler
        return () => undefined
      },
    },
    active,
    {},
    { jql: '', limit: 50, timeoutMs: 5000, promptTemplate: '' },
    new PreferenceStore(join(directory, 'prefs.json')),
    undefined,
  )
  const call = async (method, path) => {
    const endpoint = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(body) {
        this.body = body
      },
    }
    await handler({ method, url: `${ROUTE_PREFIX}${path}` }, endpoint)
    return { status: endpoint.statusCode, body: endpoint.body === undefined ? undefined : JSON.parse(endpoint.body) }
  }

  const idleStatus = await call('GET', '/status')
  check('GET /status reports idle after a sign-out', idleStatus.body?.status === 'idle', idleStatus.body?.status)
  check('GET /status reports no authorization', idleStatus.body?.authorized === false)

  // `forget` cleared the authorization, so this goes through a real browser
  // flow in production. Here it is seeded again to reach the suspend path.
  await store.patch({
    clientInformation: { client_id: 'suspend-client', redirect_uris: [`${origin}/callback`], issuer: `${origin}/auth` },
    tokens: { access_token: 'access-token', token_type: 'Bearer', refresh_token: 'refresh-token', expires_in: 3600, issuer: `${origin}/auth` },
  })
  await active.authorize()
  check('reconnects through the endpoint fixture', active.snapshot().status === 'ready', active.snapshot().status)

  const disconnected = await call('POST', '/disconnect')
  check('POST /disconnect answers 200', disconnected.status === 200, String(disconnected.status))
  check('POST /disconnect reports disconnected', disconnected.body?.status === 'disconnected', disconnected.body?.status)
  check('POST /disconnect keeps the authorization', disconnected.body?.authorized === true)
  check('POST /disconnect empties the registry', registered.size === 0, [...registered.keys()].join(','))
  const status = await call('GET', '/status')
  check('GET /status carries the authorization flag', status.body?.authorized === true)

  const forgottenAgain = await call('POST', '/forget')
  check('POST /forget answers 200', forgottenAgain.status === 200, String(forgottenAgain.status))
  check('POST /forget returns to idle', forgottenAgain.body?.status === 'idle', forgottenAgain.body?.status)
  check('POST /forget clears the authorization', forgottenAgain.body?.authorized === false)
  check('the MCP server was actually exercised', mcpRequests > 0, String(mcpRequests))
} finally {
  await active.dispose()
  await new Promise((resolve) => httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

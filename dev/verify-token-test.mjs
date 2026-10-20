// Exercises the Settings endpoints end to end against a local MCP server: the
// "Test connection" probe (healthy call, then a server that starts rejecting the
// token) and the `/tools` catalogue the Settings page searches. The rejected
// case is what proves the probe clears credentials and takes the tools down
// instead of leaving a "connected" page over a dead token.
//
// Run with: node dev/verify-token-test.mjs

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AtlassianBridge } from '../lib/bridge.js'
import { PreferenceStore } from '../lib/prefs.js'
import { registerRoutes, ROUTE_PREFIX } from '../lib/routes.js'
import { SessionStore } from '../lib/store.js'

const SITE = 'probe.example.atlassian.net'

let reject = false
let requests = 0

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** One stateless MCP server with the tool the probe prefers. */
async function handleMcp(req, res) {
  if (reject) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
    res.end()
    return
  }
  const server = new McpServer({ name: 'probe-test', version: '1.0.0' })
  server.tool('getAccessibleAtlassianResources', 'Lists the sites this token can access.', async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          data: {
            resources: [
              {
                cloudId: '00000000-0000-4000-8000-000000000000',
                url: `https://${SITE}`,
                products: [{ id: 'jira', access: 'read-write' }],
              },
            ],
          },
        }),
      },
    ],
  }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  await transport.handleRequest(req, res, await readJson(req))
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
}

const origin = (port) => `http://127.0.0.1:${port}`

const httpServer = createServer((req, res) => {
  requests += 1
  const port = httpServer.address().port
  if (req.method === 'POST' && req.url === '/mcp') {
    void handleMcp(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error))
    })
    return
  }
  // The minimum OAuth surface the SDK needs to conclude "this token is dead and
  // cannot be refreshed": protected-resource metadata, authorization-server
  // metadata, and a token endpoint that refuses the refresh.
  if (req.url?.startsWith('/.well-known/oauth-protected-resource') === true) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ resource: `${origin(port)}/mcp`, authorization_servers: [`${origin(port)}/auth`] }))
    return
  }
  if (req.url?.startsWith('/.well-known/') === true) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        issuer: `${origin(port)}/auth`,
        authorization_endpoint: `${origin(port)}/auth/authorize`,
        token_endpoint: `${origin(port)}/auth/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
    )
    return
  }
  if (req.method === 'POST' && req.url === '/auth/token') {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }))
    return
  }
  res.writeHead(405)
  res.end()
})

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port
const directory = await mkdtemp(join(tmpdir(), 'dsh-atlassian-probe-'))
const store = new SessionStore(join(directory, 'session.json'))
// Seed a credential that the fake server will reject. The healthy phase ignores
// the Authorization header; the rejected phase forces the SDK down its refresh
// path, which the fake token endpoint answers with `invalid_grant`.
await store.patch({
  clientInformation: {
    client_id: 'probe-client',
    redirect_uris: ['http://127.0.0.1/callback'],
    issuer: `${origin(port)}/auth`,
  },
  tokens: {
    access_token: 'expired-access-token',
    token_type: 'Bearer',
    refresh_token: 'dead-refresh-token',
    expires_in: 3600,
    issuer: `${origin(port)}/auth`,
  },
})

const logs = []
const bridge = new AtlassianBridge(
  {
    register: () => () => undefined,
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
  },
  {
    serverName: 'probe-test',
    url: `http://127.0.0.1:${port}/mcp`,
    // One connection for both halves: this script is about the probe. The
    // split-catalogue behaviour has its own script (verify-catalogue-split.mjs).
    boardUrl: `http://127.0.0.1:${port}/mcp`,
    redirectPort: 0,
    toolCallTimeoutMs: 5000,
    expectedSite: '',
    authorizationTimeoutMs: 5000,
    autoOpenBrowser: false,
    store,
  },
)

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

try {
  console.log('before start')
  const before = await bridge.testConnection()
  check('reports not-connected', before.verdict === 'not-connected', before.verdict)
  check('does not claim success', before.ok === false)

  await bridge.start()
  check('connected', bridge.snapshot().status === 'ready', bridge.snapshot().status)
  check('registered the probe tool', bridge.snapshot().toolCount === 1, String(bridge.snapshot().toolCount))

  console.log('\ntool catalogue')
  const catalogue = bridge.tools()
  check('exposes every registered tool', catalogue.length === 1, String(catalogue.length))
  check(
    'uses the public DSH name',
    catalogue[0]?.name === 'mcp__probe-test__getAccessibleAtlassianResources',
    catalogue[0]?.name,
  )
  check('keeps the raw MCP name', catalogue[0]?.rawName === 'getAccessibleAtlassianResources', catalogue[0]?.rawName)
  check(
    'keeps the server description',
    catalogue[0]?.description === 'Lists the sites this token can access.',
    catalogue[0]?.description,
  )

  console.log('\ntools endpoint')
  let handler
  registerRoutes(
    {
      register(route) {
        handler = route.handler
        return () => undefined
      },
    },
    bridge,
    {},
    { jql: '', limit: 50, timeoutMs: 5000, promptTemplate: '' },
    new PreferenceStore(join(directory, 'prefs.json')),
    undefined,
  )
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
  await handler({ method: 'GET', url: `${ROUTE_PREFIX}/tools` }, endpoint)
  const served = JSON.parse(endpoint.body)
  check('serves the catalogue over HTTP', endpoint.statusCode === 200, String(endpoint.statusCode))
  check('returns every tool', served.tools?.length === 1, String(served.tools?.length))
  check(
    'carries the description over the wire',
    served.tools?.[0]?.description === 'Lists the sites this token can access.',
    served.tools?.[0]?.description,
  )

  console.log('\nhealthy probe')
  const healthy = await bridge.testConnection()
  check('verdict is valid', healthy.verdict === 'valid', healthy.verdict)
  check('ok is true', healthy.ok === true)
  check('names the probe tool', healthy.tool === 'getAccessibleAtlassianResources', String(healthy.tool))
  check('reports the site', healthy.site === SITE, String(healthy.site))
  check('persisted the site', bridge.snapshot().site === SITE, String(bridge.snapshot().site))
  check('records a duration', typeof healthy.durationMs === 'number' && healthy.durationMs >= 0)

  console.log('\nconcurrent probes share one result')
  const [first, second] = await Promise.all([bridge.testConnection(), bridge.testConnection()])
  check('both clicks finish', first.verdict === 'valid' && second.verdict === 'valid')

  console.log('\nrejected token')
  reject = true
  const rejected = await bridge.testConnection()
  check('verdict is invalid', rejected.verdict === 'invalid', rejected.verdict + ' :: ' + rejected.message)
  check('does not claim success', rejected.ok === false)
  check('clears the tools', bridge.snapshot().toolCount === 0, String(bridge.snapshot().toolCount))
  check('clears the tool catalogue', bridge.tools().length === 0, String(bridge.tools().length))
  check('moves to error', bridge.snapshot().status === 'error', bridge.snapshot().status)
  check('offers no stale authorization URL', bridge.snapshot().authorizationUrl === undefined)
  check('clears the stored tokens', (await store.load()).tokens === undefined)
  check('warns in the log', logs.some((line) => line.startsWith('warn') && line.includes('rejected')), logs.join(' | '))

  const after = await bridge.testConnection()
  check('a later probe is not-connected', after.verdict === 'not-connected', after.verdict)
  check('the MCP server was actually exercised', requests > 0, String(requests))
} finally {
  await bridge.dispose()
  await new Promise((resolve) => httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

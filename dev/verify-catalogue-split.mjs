// Proves the two-connection split: the model registers only what `/mcp` lists,
// while the board can call a tool that exists only on `/mcp?tools=all`.
//
// Two fake MCP servers on one origin:
//   /mcp            → primary tools only (what the model should see)
//   /mcp?tools=all  → the flat catalogue (+ a board-only tool)
//
// Run with: node dev/verify-catalogue-split.mjs

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AtlassianBridge } from '../lib/bridge.js'
import { SessionStore } from '../lib/store.js'

const SITE = 'split.example.atlassian.net'

/** Tools the model's endpoint lists. */
const PRIMARY = ['getAccessibleAtlassianResources', 'getJiraIssue', 'searchJiraIssuesUsingJql']
/** Tools only the flat catalogue lists. */
const BOARD_ONLY = ['listJiraProjects', 'getJiraBoardSprintData', 'listJiraIssueTransitions']

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function buildServer(flat) {
  const server = new McpServer({ name: flat ? 'flat' : 'primary', version: '1.0.0' })
  const names = flat ? [...PRIMARY, ...BOARD_ONLY] : PRIMARY
  for (const name of names) {
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
    const flat = url.searchParams.get('tools') === 'all'
    void (async () => {
      const server = buildServer(flat)
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
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    const port = httpServer.address().port
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`http://127.0.0.1:${port}/auth`] }))
    return
  }
  if (url.pathname.startsWith('/.well-known/')) {
    const port = httpServer.address().port
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
const directory = await mkdtemp(join(tmpdir(), 'dsh-atlassian-split-'))
const store = new SessionStore(join(directory, 'session.json'))
await store.patch({
  clientInformation: { client_id: 'split-client', redirect_uris: [`${origin}/callback`], issuer: `${origin}/auth` },
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
const bridge = new AtlassianBridge(
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
    serverName: 'split',
    url: `${origin}/mcp`,
    boardUrl: `${origin}/mcp?tools=all`,
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
  await bridge.start()
  check('connected', bridge.snapshot().status === 'ready', bridge.snapshot().status)

  console.log('\nmodel side')
  check('registers only the primary tools', bridge.snapshot().toolCount === PRIMARY.length, String(bridge.snapshot().toolCount))
  check('registers getJiraIssue', registered.has('mcp__split__getJiraIssue'))
  check('does not register listJiraProjects', !registered.has('mcp__split__listJiraProjects'))
  check('does not register getJiraBoardSprintData', !registered.has('mcp__split__getJiraBoardSprintData'))

  console.log('\nboard side')
  check('board resolves a flat-only tool', bridge.rawNameMatching(/^listJiraProjects$/i) === 'listJiraProjects')
  check(
    'board resolves the sprint-catalogue tool',
    bridge.rawNameMatching(/^getJiraBoardSprintData$/i) === 'getJiraBoardSprintData',
  )
  const content = await bridge.callTool('listJiraProjects', {})
  check('board can call a flat-only tool', JSON.stringify(content).includes('listJiraProjects'), JSON.stringify(content))
  const viaPrimary = await bridge.callTool('getJiraIssue', { issueIdOrKey: 'X-1' })
  check('board shares the model connection for primary tools', JSON.stringify(viaPrimary).includes('getJiraIssue'))

  console.log('\ncatalogue')
  const catalogue = bridge.tools()
  check('lists both catalogues without duplicates', catalogue.length === PRIMARY.length + BOARD_ONLY.length, String(catalogue.length))
  check('marks every primary tool registered', catalogue.filter((t) => t.registered).length === PRIMARY.length, String(catalogue.filter((t) => t.registered).length))
  const flagged = catalogue.filter((t) => !t.registered).map((t) => t.rawName)
  check('marks flat-only tools board-only', BOARD_ONLY.every((name) => flagged.includes(name)), flagged.join(','))
  check('never invents a name', catalogue.every((t) => t.name.startsWith('mcp__split__')), catalogue.map((t) => t.name).join(','))

  console.log('\ndiagnostics')
  check('rawNames covers the board catalogue', bridge.rawNames().length === PRIMARY.length + BOARD_ONLY.length, String(bridge.rawNames().length))
  check('logs the board catalogue size', logs.some((line) => line.includes('board-only')), logs.join(' | '))
} finally {
  await bridge.dispose()
  await new Promise((resolve) => httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

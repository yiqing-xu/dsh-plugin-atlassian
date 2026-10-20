// Exercises the compiled board against captured real Atlassian MCP payloads.
//
// A live board test would need an OAuth authorization; this harness supplies
// the same bytes the MCP server returns (captured from the real site) to the
// real `JiraBoard` class, so JSON parsing, field mapping, column grouping, and
// the unconstrained-JQL fallback are all covered without a connection.
//
// The ONE thing this cannot cover is `tools/call` transport itself — that path
// is exercised by the existing bridged tools in a normal session.
//
// Run with: node dev/verify-board.mjs

import { JiraBoard } from '../lib/board.js'

const SITE = 'example.atlassian.net'
const CLOUD_ID = '11111111-2222-4333-8444-555555555555'

/** Wrap a JSON document the way the MCP server does: one text content block. */
const block = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

/** Real v2 response shape from `getAccessibleAtlassianResources`. */
const RESOURCES_BODY = {
  resources: [
    {
      cloudId: CLOUD_ID,
      url: `https://${SITE}`,
      products: [
        { id: 'jira', access: 'read-write' },
        { id: 'confluence', access: 'read-write' },
      ],
    },
  ],
}

/** v2 wraps every tool answer in `{ data }`. */
const RESOURCES = { data: RESOURCES_BODY }

/** Real v2 response shape from `searchJiraIssuesUsingJql`, trimmed to two issues. */
const SEARCH_BODY = {
  issues: [
    {
      id: '10107',
      key: 'DEMOAPP-27',
      fields: {
        summary: '示例任务：等级铭牌与奖励结算反馈',
        issuetype: { id: '10005', name: '故事', subtask: false },
        project: { id: '10003', key: 'DEMOAPP', name: '示例｜用户 App' },
        description: '## 示例描述\n\n* 示例要点一。\n* 示例要点二。\n\n[示例链接](https://example.com/README.md)',
        assignee: null,
        priority: { id: '2', name: 'High' },
        updated: '2026-09-17T03:44:29.154+0800',
        // Jira answers the sprint field as an array, oldest first: the active
        // sprint comes LAST. The board has to order it the other way round.
        sprint: [
          {
            id: 41,
            name: '冲刺41',
            state: 'closed',
            startDate: '2026-07-01T00:00:00.000Z',
            endDate: '2026-07-15T00:00:00.000Z',
          },
          {
            id: 44,
            name: '冲刺44',
            state: 'active',
            startDate: '2026-09-10T01:39:10.000Z',
            endDate: '2026-10-15T10:39:00.000Z',
          },
        ],
        status: {
          id: '10010',
          name: '开发中',
          statusCategory: { id: 4, key: 'indeterminate', colorName: 'yellow', name: '正在进行' },
        },
      },
    },
    {
      id: '10168',
      key: 'DEMOAPP-34',
      fields: {
        summary: '示例任务：地址与物流展示',
        issuetype: { id: '10005', name: '故事', subtask: false },
        project: { id: '10003', key: 'DEMOAPP', name: '示例｜用户 App' },
        description: null,
        assignee: { displayName: 'Example User' },
        priority: { id: '4', name: 'Low' },
        updated: '2026-09-17T03:44:48.983+0800',
        status: {
          id: '10008',
          name: '待梳理',
          statusCategory: { id: 2, key: 'new', colorName: 'blue-gray', name: '待办' },
        },
      },
    },
  ],
  isLast: true,
}

const SEARCH = { data: SEARCH_BODY }

/** Real v2 response shape from `listJiraIssueTransitions`. */
const TRANSITIONS = {
  data: {
    transitions: [
      { id: '11', name: '待梳理', to: { name: '待梳理', statusCategory: { key: 'new' } }, isAvailable: true },
      { id: '21', name: '待开发', to: { name: '待开发', statusCategory: { key: 'new' } }, isAvailable: true },
      { id: '61', name: '已完成', to: { name: '已完成', statusCategory: { key: 'done' } }, isAvailable: true },
    ],
  },
}

/** Real v2 response shape from `listJiraProjects`. */
const PROJECTS = {
  data: {
    maxResults: 50,
    total: 2,
    isLast: true,
    values: [
      { id: '10004', key: 'DEMOAPI', name: '示例｜App 业务 API' },
      { id: '10003', key: 'DEMOAPP', name: '示例｜用户 App' },
    ],
  },
}

/**
 * The MCP tool names the board looks for, in one place.
 *
 * Shared by every bridge double in this file: a double that knows fewer names
 * than the board asks for reports a `missing-tool` error, which looks like a
 * product-permission problem rather than a stale harness.
 */
const TOOL_NAMES = {
  resources: 'getAccessibleAtlassianResources',
  search: 'searchJiraIssuesUsingJql',
  issue: 'getJiraIssue',
  transitions: 'listJiraIssueTransitions',
  transition: 'transitionJiraIssue',
  projects: 'listJiraProjects',
  fieldMeta: 'getJiraIssueTypeMetaWithFields',
  boardSprints: 'getJiraBoardSprintData',
}

/**
 * A bridge double that answers by tool fragment.
 *
 * It also asserts that the cloudId is threaded through: the DSH session tools
 * inject it for the model, but a plugin must carry it itself, and a board that
 * quietly dropped it would fail against the real server.
 */
function fakeBridge() {
  const calls = []
  const names = TOOL_NAMES
  return {
    calls,
    rawNameMatching(pattern) {
      for (const raw of Object.values(names)) if (pattern.test(raw)) return raw
      return undefined
    },
    async callTool(rawName, args) {
      calls.push({ rawName, args })
      if (rawName === names.resources) return block(RESOURCES)
      if (rawName === names.search) return block(SEARCH)
      if (rawName === names.issue) {
        return block({ data: { appliedContentFormat: 'markdown', ...SEARCH_BODY.issues[0] } })
      }
      if (rawName === names.transitions) return block(TRANSITIONS)
      if (rawName === names.transition) return block('Issue DEMOAPP-27 transitioned')
      if (rawName === names.projects) return block(PROJECTS)
      return block('unknown tool')
    },
  }
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

const bridge = fakeBridge()
const board = new JiraBoard(bridge)

console.log('board.load()')
const payload = await board.load({ limit: 50, timeoutMs: 5000 })
check('returns both issues', payload.issues.length === 2, `got ${String(payload.issues.length)}`)
check('resolves the authorized site', payload.site === SITE, String(payload.site))
check('resolves the registry id', payload.cloudId === CLOUD_ID, String(payload.cloudId))

const grown = payload.issues.find((issue) => issue.key === 'DEMOAPP-27')
check('maps key/summary', grown?.summary === '示例任务：等级铭牌与奖励结算反馈', grown?.summary)
check('maps the status name', grown?.status.name === '开发中', grown?.status.name)
check('maps the status category', grown?.status.categoryKey === 'indeterminate', grown?.status.categoryKey)
check('maps the category label', grown?.status.categoryName === '正在进行', grown?.status.categoryName)
check('maps the issue type', grown?.type === '故事', grown?.type)
check('maps priority', grown?.priority === 'High', grown?.priority)
check('maps the project', grown?.projectKey === 'DEMOAPP' && grown?.projectName === '示例｜用户 App', grown?.projectKey)
check('builds the browse URL', grown?.url === `https://${SITE}/browse/DEMOAPP-27`, grown?.url)
check('leaves a null assignee unset', grown?.assignee === undefined, String(grown?.assignee))

const unassigned = payload.issues.find((issue) => issue.key === 'DEMOAPP-34')
check('maps a present assignee', unassigned?.assignee === 'Example User', unassigned?.assignee)
check('leaves a null description out of the card model', !('description' in (unassigned ?? {})), 'description leaked')

// The sprint array is what the chip row is derived from. Jira sends it oldest
// first, so the panel reads the ACTIVE sprint out of position, not off the end.
console.log('\nsprints')
check('maps every sprint', grown?.sprints.length === 2, String(grown?.sprints.length))
check('orders the active sprint first', grown?.sprints[0]?.id === '44', grown?.sprints[0]?.id)
check('keeps the newer sprint leftmost', grown?.sprints[1]?.id === '41', grown?.sprints[1]?.id)
check('carries the sprint name', grown?.sprints[0]?.name === '冲刺44', grown?.sprints[0]?.name)
check('carries the sprint state', grown?.sprints[0]?.state === 'active', grown?.sprints[0]?.state)
check('carries the sprint window', grown?.sprints[0]?.endDate === '2026-10-15T10:39:00.000Z', grown?.sprints[0]?.endDate)
check('an issue outside every sprint gets an empty list', unassigned?.sprints.length === 0, JSON.stringify(unassigned?.sprints))

const searchCall = bridge.calls.find((call) => call.rawName === 'searchJiraIssuesUsingJql')
check('carries cloudId into the search', searchCall?.args.cloudId === CLOUD_ID, String(searchCall?.args.cloudId))
check('requests the fields the panel renders', Array.isArray(searchCall?.args.fields) && searchCall.args.fields.includes('status'))
// Naming the sprint field `sprint` does NOT work against the real server: custom
// fields are dropped unless their `customfield_*` id is requested, which is what
// made every sprint chip empty. The id is resolved (or defaulted) and sent.
check(
  'asks for the sprint field by ID',
  Array.isArray(searchCall?.args.fields) && searchCall.args.fields.includes('customfield_10020'),
  JSON.stringify(searchCall?.args.fields),
)
check(
  'does not bother asking for a name-only sprint field',
  Array.isArray(searchCall?.args.fields) && !searchCall.args.fields.includes('sprint'),
)
check('honours the safety ceiling', searchCall?.args.maxResults === 50, String(searchCall?.args.maxResults))
check('asks for the full projection v2 needs for category and project', searchCall?.args.view === 'full', String(searchCall?.args.view))

// A site whose sprint field is not `customfield_10020` names its own id, and
// that id must be the one requested — the field is asked for by id or not at
// all, so a configured value has to replace the default rather than sit beside
// it.
console.log('\nconfigured sprint field')
const customBridge = {
  calls: [],
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName, args) {
    this.calls.push({ rawName, args })
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    return block({
      data: {
        issues: [
          {
            id: '1',
            key: 'DEMOAPP-1',
            fields: {
              summary: 'x',
              status: { name: '待办', statusCategory: { key: 'new', name: '待办' } },
              customfield_10233: [{ id: 5740, name: '冲刺44', state: 'ACTIVE' }],
            },
          },
        ],
        isLast: true,
      },
    })
  },
}
const custom = new JiraBoard(customBridge)
const customPayload = await custom.load({
  jql: 'project = DEMOAPP',
  limit: 10,
  timeoutMs: 5000,
  sprintField: 'customfield_10233',
})
const customCall = customBridge.calls.find((call) => call.rawName === 'searchJiraIssuesUsingJql')
check('requests the configured id', customCall?.args.fields.includes('customfield_10233') === true, JSON.stringify(customCall?.args.fields))
check(
  'the configured id replaces the default one',
  customCall?.args.fields.includes('customfield_10020') === false,
  JSON.stringify(customCall?.args.fields),
)
check(
  'reads a sprint off the configured field',
  customPayload.issues[0]?.sprints[0]?.name === '冲刺44',
  JSON.stringify(customPayload.issues[0]?.sprints),
)
check(
  'lower-cases a shouted state',
  customPayload.issues[0]?.sprints[0]?.state === 'active',
  customPayload.issues[0]?.sprints[0]?.state,
)

// The shape the v2 server ACTUALLY returns for a custom field: `fields.sprint`
// is absent, and the sprint lives under `fields.customFields` keyed by the
// field's localized display name, wrapped in `{ id, value }`. This is the case a
// real site hits, so it must not depend on the field being called `sprint`.
console.log('\nlocalized customFields projection')
const localizedBridge = {
  calls: [],
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName, args) {
    this.calls.push({ rawName, args })
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    return block({
      data: {
        issues: [
          {
            id: '4103493',
            key: 'PICDLY-12522',
            fields: {
              summary: '示例任务',
              status: { name: '已关闭', statusCategory: { key: 'done', name: '完成' } },
              project: { key: 'PICDLY', name: '示例项目' },
              customFields: {
                冲刺: {
                  id: 'customfield_10020',
                  value: [
                    {
                      id: 5740,
                      name: '冲刺44',
                      state: 'active',
                      startDate: '2026-09-10T01:39:10.000Z',
                      endDate: '2026-10-15T10:39:00.000Z',
                    },
                  ],
                },
                缺陷严重程度: { id: 'customfield_10177', value: { value: '一般', id: '10244' } },
              },
            },
          },
          {
            id: '4103535',
            key: 'PICDLY-12555',
            fields: {
              summary: '没有冲刺的工单',
              status: { name: '待办', statusCategory: { key: 'new', name: '待办' } },
              customFields: { 冲刺: { id: 'customfield_10020', value: [] } },
            },
          },
        ],
        isLast: true,
      },
    })
  },
}
const localized = await new JiraBoard(localizedBridge).load({ jql: 'project = PICDLY', limit: 10, timeoutMs: 5000 })
check(
  'reads the sprint out of the localized customFields entry',
  localized.issues[0]?.sprints[0]?.name === '冲刺44',
  JSON.stringify(localized.issues[0]?.sprints),
)
check(
  'normalizes the numeric sprint id to text',
  localized.issues[0]?.sprints[0]?.id === '5740',
  String(localized.issues[0]?.sprints[0]?.id),
)
check(
  'does not mistake a select custom field for a sprint list',
  localized.issues[0]?.sprints.length === 1,
  JSON.stringify(localized.issues[0]?.sprints),
)
check(
  'an empty sprint list means "in no sprint"',
  localized.issues[1]?.sprints.length === 0,
  JSON.stringify(localized.issues[1]?.sprints),
)

// Naming the field by id must pick that entry even when another custom field on
// the same issue happens to look sprint-shaped.
console.log('\nsprint field chosen by configured id')
const twoSprintFields = {
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    return block({
      data: {
        issues: [
          {
            id: '1',
            key: 'DEMOAPP-1',
            fields: {
              summary: 'x',
              status: { name: '待办', statusCategory: { key: 'new', name: '待办' } },
              customFields: {
                发现冲刺: { id: 'customfield_11488', value: [{ id: 1, name: '冲刺1', state: 'closed' }] },
                冲刺: { id: 'customfield_10020', value: [{ id: 5740, name: '冲刺44', state: 'active' }] },
              },
            },
          },
        ],
        isLast: true,
      },
    })
  },
}
const picked = await new JiraBoard(twoSprintFields).load({
  jql: 'project = DEMOAPP',
  limit: 10,
  timeoutMs: 5000,
  sprintField: 'customfield_10020',
})
check(
  'the configured id wins over shape matching',
  picked.issues[0]?.sprints[0]?.name === '冲刺44',
  JSON.stringify(picked.issues[0]?.sprints),
)

// The sprint CATALOGUE. A sprint is a named option on a project ("镇海炼化冲刺
// 15.5"), and a project can run well over a hundred, so the panel asks the
// server for the list instead of deriving it from the page it happens to hold.
//
// v2 exposes `getJiraBoardSprintData` and nothing else for this: there is no
// `listJiraBoards`, and a project with several boards is refused as ambiguous.
// These doubles reproduce both shapes the real server answers with.
console.log('\nboard.sprints()')
const SPRINTS_BY_BOARD = {
  63: {
    data: {
      board: { id: 63, name: '项目需求开发RD003面板', type: 'scrum' },
      sprints: [
        { id: 3002, name: '中海油零库存信创部署', state: 'closed', endDate: '2025-11-11T10:00:00.000Z' },
        { id: 5777, name: '中海油备件零库存 lkc_8', state: 'closed', endDate: '2026-06-18T10:00:00.000Z' },
        { id: 5603, name: '中海油备件零库存 lkc_9', state: 'future' },
        { id: 6001, name: '镇海炼化冲刺15.5', state: 'active', endDate: '2026-11-01T10:00:00.000Z' },
      ],
    },
  },
  1117: {
    data: {
      board: { id: 1117, name: 'lkc', type: 'scrum' },
      sprints: [
        // Duplicated with board 63 on purpose: the same sprint is offered by
        // both boards, and the chip row must not show it twice.
        { id: 6001, name: '镇海炼化冲刺15.5', state: 'active' },
        { id: 4773, name: '中海油备件零库存 历史遗留需求', state: 'future' },
      ],
    },
  },
}
/** The refusal the real server sends for a project with more than one board. */
const AMBIGUOUS = new Error(
  'Multiple Jira boards matched: 项目需求开发RD003面板 (#63, RD003), lkc (#1117, RD003). ' +
    'Multiple boards could satisfy an active sprint. Provide boardId or boardName to disambiguate.',
)
const catalogueBridge = {
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName, args) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    if (rawName === 'getJiraBoardSprintData') {
      if (args.boardId === undefined) throw AMBIGUOUS
      const answer = SPRINTS_BY_BOARD[args.boardId]
      if (answer === undefined) throw new Error('403 no permission')
      return block(answer)
    }
    return block('{}')
  },
}
const catalogue = await new JiraBoard(catalogueBridge).sprints('RD003', 5000)
check('lists sprints across every board', catalogue.length === 5, `${String(catalogue.length)}: ${catalogue.map((s) => s.name).join(',')}`)
check(
  'de-duplicates a sprint offered by two boards',
  catalogue.filter((sprint) => sprint.id === '6001').length === 1,
  JSON.stringify(catalogue.filter((sprint) => sprint.id === '6001')),
)
check(
  'keeps a closed sprint that no current issue carries',
  catalogue.some((sprint) => sprint.id === '3002' && sprint.state === 'closed'),
  JSON.stringify(catalogue.map((sprint) => sprint.id)),
)
check(
  'normalizes numeric sprint ids to text',
  catalogue.every((sprint) => typeof sprint.id === 'string'),
)
check(
  'a board that refuses to list does not fail the rest',
  catalogue.length >= 4,
  String(catalogue.length),
)
check(
  'remembers which board a sprint came from',
  catalogue.find((sprint) => sprint.id === '4773')?.boardName === 'lkc',
  JSON.stringify(catalogue.find((sprint) => sprint.id === '4773')),
)

// One board answers directly: no ambiguity, so no second round-trip is spent.
const singleBridge = {
  rawNameMatching: bridge.rawNameMatching,
  calls: [],
  async callTool(rawName, args) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    if (rawName === 'getJiraBoardSprintData') {
      this.calls.push(args)
      return block(SPRINTS_BY_BOARD[63])
    }
    return block('{}')
  },
}
const single = await new JiraBoard(singleBridge)
const singleSprints = await single.sprints('RD003', 5000)
check('reads a project whose board is unambiguous', singleSprints.length === 4, String(singleSprints.length))
check(
  'sends includeIssues:false, which is what keeps the call to metadata',
  singleBridge.calls[0]?.includeIssues === false,
  JSON.stringify(singleBridge.calls[0]),
)
check(
  'sends the project key, not a board id, on the first attempt',
  singleBridge.calls[0]?.projectKeyOrId === 'RD003' && singleBridge.calls[0]?.boardId === undefined,
  JSON.stringify(singleBridge.calls[0]),
)

// A kanban board genuinely holds no sprints. The server says so with a 400 and
// a message, so the row renders empty instead of an error the user cannot act on.
const kanbanBridge = {
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    if (rawName === 'getJiraBoardSprintData') {
      throw new Error('Failed to fetch board sprints: 400 {"errorMessages":["此面板不支持冲刺"]}')
    }
    return block('{}')
  },
}
check(
  'a kanban board yields an empty catalogue, not an error',
  (await new JiraBoard(kanbanBridge).sprints('PICDLY', 5000)).length === 0,
)

// A missing tool is a deployment problem and must stay visible: swallowing it
// into "no sprints" would look like an empty project.
const missingToolBridge = {
  rawNameMatching() {
    return undefined
  },
  async callTool() {
    return block('{}')
  },
  snapshot() {
    return { status: 'ready' }
  },
}
let missingCode
try {
  await new JiraBoard(missingToolBridge).sprints('RD003', 5000)
} catch (error) {
  missingCode = error.code ?? error.name
}
check('a missing sprint tool is reported, not swallowed', missingCode === 'missing-tool', String(missingCode))

// No project means nothing to list, and the endpoint is asked with one always.
check('an empty project lists nothing', (await new JiraBoard(catalogueBridge).sprints('   ', 5000)).length === 0)

// The unconstrained-JQL fallback: Atlassian refuses a bare `order by`, and the
// board must retry with a bounded query rather than surface that as an error.
console.log('\nunconstrained JQL fallback')
const refusing = {
  calls: [],
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName, args) {
    this.calls.push({ rawName, args })
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    if (rawName === 'searchJiraIssuesUsingJql') {
      if (!/updated >=/.test(String(args.jql))) {
        throw new Error('Bad Request. 此处不允许使用无限制的 JQL 查询。请在查询中添加搜索限制。')
      }
      return block(SEARCH)
    }
    return block('{}')
  },
}
const recovering = new JiraBoard(refusing)
const fallback = await recovering.load({ jql: 'order by updated DESC', limit: 50, timeoutMs: 5000 })
check('retries with a bounded query', /updated >=/.test(fallback.jql), fallback.jql)
check('marks the result as constrained', fallback.constrained === true)
check('still returns issues', fallback.issues.length === 2, String(fallback.issues.length))

// A genuinely broken query must surface, not be silently replaced.
console.log('\nbad JQL is reported')
const broken = {
  calls: [],
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    throw new Error("Field 'nonsense' does not exist or you do not have permission to view it.")
  },
}
let surfaced = ''
try {
  await new JiraBoard(broken).load({ jql: 'nonsense = 1', limit: 10, timeoutMs: 5000 })
} catch (error) {
  surfaced = error instanceof Error ? error.message : String(error)
}
check('propagates the server message', /does not exist/i.test(surfaced), surfaced)

console.log('\nboard.detail()')
const detail = await board.detail('DEMOAPP-27', 5000)
check('returns the description as markdown', detail.description.startsWith('## 示例描述'), detail.description.slice(0, 40))
check('returns the issue too', detail.issue.key === 'DEMOAPP-27')
check('uses the issue-level tool', bridge.calls.some((call) => call.rawName === 'getJiraIssue'))

console.log('\nboard.transitions()')
const transitions = await board.transitions('DEMOAPP-27', 5000)
check('maps every transition', transitions.length === 3, String(transitions.length))
check('maps the target status name', transitions[2]?.toName === '已完成', transitions[2]?.toName)
check('maps the target category', transitions[2]?.toCategoryKey === 'done', transitions[2]?.toCategoryKey)

console.log('\nboard.transition()')
await board.transition('DEMOAPP-27', '61', 5000)
const applied = bridge.calls.filter((call) => call.rawName === 'transitionJiraIssue').pop()
check('sends the v2 transitionId field', applied?.args.transitionId === '61', JSON.stringify(applied?.args))
check('carries cloudId into the write', applied?.args.cloudId === CLOUD_ID, String(applied?.args.cloudId))

console.log('\nboard.projects()')
const projects = await board.projects(5000)
check('lists the visible projects', projects.length === 2, String(projects.length))
check('sorts by key', projects[0]?.key === 'DEMOAPI', projects[0]?.key)

// The project ROW is built from this list, so a truncated answer is exactly how
// a project somebody works in every day would be absent from the board. This
// tool pages by startAt OFFSET (its `nextPage` is a URL, not a token), so the
// walk advances by the page size and stops on `isLast`.
console.log('\nboard.projects() paging')
const pagedProjects = (() => {
  const pages = [
    { data: { values: [{ key: 'ALPHA', name: 'A', insight: { lastIssueUpdateTime: '2026-10-01T00:00:00.000Z' } }, { key: 'BETA', name: 'B' }], isLast: false, total: 3 } },
    { data: { values: [{ key: 'GAMMA', name: 'G' }, { key: 'ALPHA', name: 'dup' }], isLast: true, total: 3 } },
  ]
  const calls = []
  let index = 0
  return {
    calls,
    bridge: {
      rawNameMatching: (pattern) => (pattern.test(TOOL_NAMES.projects) ? TOOL_NAMES.projects : pattern.test(TOOL_NAMES.resources) ? TOOL_NAMES.resources : undefined),
      async callTool(rawName, args) {
        calls.push({ rawName, args })
        if (rawName === TOOL_NAMES.resources) return block(RESOURCES)
        const page = pages[index] ?? pages[pages.length - 1]
        index += 1
        return block(page)
      },
    },
  }
})()
const walked = await new JiraBoard(pagedProjects.bridge).projects(5000)
check('walks past the first page', walked.length === 3, walked.map((entry) => entry.key).join(','))
const projectCalls = pagedProjects.calls.filter((c) => c.rawName === TOOL_NAMES.projects)
check('advances by the page offset', projectCalls[1]?.args.startAt === 2, JSON.stringify(projectCalls.map((c) => c.args.startAt)))
check('asks for the largest page it can', projectCalls[0]?.args.maxResults === 100)
check('asks for the recency insight', projectCalls[0]?.args.expand === 'insight')
check('collapses a project seen on two pages', walked.filter((entry) => entry.key === 'ALPHA').length === 1)
check('carries the last-update stamp', walked.find((entry) => entry.key === 'ALPHA')?.updated === '2026-10-01T00:00:00.000Z')
check('stops when the site says it is done', projectCalls.length === 2)

// A search answer that is not complete is PAGED, not accepted as the whole
// board: the panel holds a project, not whatever fitted in one response.
console.log('\nboard.load() paging')
const pagedSearch = (() => {
  const issue = (key) => ({ id: key, key, fields: { summary: key, status: { name: '待办', statusCategory: { key: 'new', name: '待办' } }, project: { key: 'DEMO', name: 'Demo' } } })
  const pages = [
    { data: { issues: [issue('DEMO-1')], isLast: false, nextPageToken: 't1' } },
    { data: { issues: [issue('DEMO-2')], isLast: false, nextPageToken: 't2' } },
    { data: { issues: [issue('DEMO-3')], isLast: true } },
  ]
  const calls = []
  let index = 0
  return {
    calls,
    bridge: {
      rawNameMatching: (pattern) => (pattern.test(TOOL_NAMES.search) ? TOOL_NAMES.search : pattern.test(TOOL_NAMES.resources) ? TOOL_NAMES.resources : undefined),
      async callTool(rawName, args) {
        calls.push({ rawName, args })
        if (rawName === TOOL_NAMES.resources) return block(RESOURCES)
        const page = pages[index] ?? pages[pages.length - 1]
        index += 1
        return block(page)
      },
    },
  }
})()
const pagedPayload = await new JiraBoard(pagedSearch.bridge).load({ jql: 'project = DEMO', limit: 5000, timeoutMs: 5000 })
check('collects every page', pagedPayload.issues.length === 3, String(pagedPayload.issues.length))
check('asks for a full page each time', pagedSearch.calls.filter((c) => c.rawName === TOOL_NAMES.search).every((c) => c.args.maxResults === 100))
check('carries the page token forward', pagedSearch.calls.filter((c) => c.rawName === TOOL_NAMES.search)[1]?.args.nextPageToken === 't1')
check('does not report a complete read as truncated', pagedPayload.truncated === false)

// The ceiling is a safety net, and reaching it must be VISIBLE rather than
// silently presented as a complete board.
const capped = (() => {
  let index = 0
  return {
    rawNameMatching: (pattern) => (pattern.test(TOOL_NAMES.search) ? TOOL_NAMES.search : pattern.test(TOOL_NAMES.resources) ? TOOL_NAMES.resources : undefined),
    async callTool(rawName) {
      if (rawName === TOOL_NAMES.resources) return block(RESOURCES)
      index += 1
      return block({ data: { issues: [{ id: String(index), key: `DEMO-${String(index)}`, fields: { summary: 'x' } }], isLast: false, nextPageToken: `t${String(index)}` } })
    },
  }
})()
const cappedPayload = await new JiraBoard(capped).load({ jql: 'project = DEMO', limit: 2, timeoutMs: 5000 })
check('honours the safety ceiling', cappedPayload.issues.length === 2, String(cappedPayload.issues.length))
check('reports a capped read as truncated', cappedPayload.truncated === true)


// The v1 endpoint answered with the payload itself, not `{ data }`. Keeping
// that shape parseable means a captured v1 answer or a temporary fallback URL
// still renders instead of silently emptying the board.
console.log('\nv1 payloads still parse')
const legacy = new JiraBoard({
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES_BODY.resources)
    if (rawName === 'searchJiraIssuesUsingJql') return block(SEARCH_BODY)
    return block('{}')
  },
})
const legacyPayload = await legacy.load({ limit: 10, timeoutMs: 5000 })
check('reads a bare resource array', legacyPayload.cloudId === CLOUD_ID, String(legacyPayload.cloudId))
check('reads a bare search body', legacyPayload.issues.length === 2, String(legacyPayload.issues.length))

// v2's `evidence` projection carries only the localized category name. The
// panel filters by key, so the name has to map back onto Jira's buckets.
console.log('\nname-only status categories')
const nameOnly = new JiraBoard({
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    return block({
      data: {
        issues: [
          {
            id: '1',
            key: 'DEMOAPP-1',
            fields: { summary: 'x', status: { name: '已关闭', statusCategory: { name: '完成' } } },
          },
        ],
        isLast: true,
      },
    })
  },
})
const nameOnlyPayload = await nameOnly.load({ limit: 5, timeoutMs: 5000 })
check(
  'maps 完成 back to the done bucket',
  nameOnlyPayload.issues[0]?.status.categoryKey === 'done',
  nameOnlyPayload.issues[0]?.status.categoryKey,
)

// v2 refuses Markdown whenever the body holds media or mentions and answers
// HTML instead. The drawer renders Markdown, so the board must flatten it.
console.log('\nHTML descriptions are flattened')
const htmlBridge = {
  rawNameMatching: bridge.rawNameMatching,
  async callTool(rawName) {
    if (rawName === 'getAccessibleAtlassianResources') return block(RESOURCES)
    return block({
      data: {
        appliedContentFormat: 'html',
        ...SEARCH_BODY.issues[0],
        fields: {
          ...SEARCH_BODY.issues[0].fields,
          description:
            '<p>说明 &amp; 背景</p><p><a href="https://example.com/x">链接</a></p><figure><div data-type="media" data-alt="shot.png"></div></figure>',
        },
      },
    })
  },
}
const htmlDetail = await new JiraBoard(htmlBridge).detail('DEMOAPP-27', 5000)
check('keeps the text', htmlDetail.description.includes('说明 & 背景'), htmlDetail.description)
check('keeps the link', htmlDetail.description.includes('[链接](https://example.com/x)'), htmlDetail.description)
check('marks the image', htmlDetail.description.includes('[图片：shot.png]'), htmlDetail.description)
check('drops every tag', !/<[a-z][^>]*>/i.test(htmlDetail.description), htmlDetail.description)

console.log('\nnot connected')
const offline = new JiraBoard({
  rawNameMatching: () => undefined,
  async callTool() {
    throw new Error('unreachable')
  },
})
check('reports itself unavailable', offline.available() === false)
let offlineError = ''
try {
  await offline.load({ limit: 10, timeoutMs: 1000 })
} catch (error) {
  offlineError = error instanceof Error ? error.message : String(error)
}
check('fails with a diagnosable code', offlineError.includes('没有提供匹配'), offlineError)

// A bridge that is still authorizing has discovered no tools either — but that
// is a connection problem, and saying "no such tool" would send the user
// looking for a permission they do not need.
console.log('\nstill authorizing')
const authorizing = new JiraBoard({
  rawNameMatching: () => undefined,
  async callTool() {
    throw new Error('unreachable')
  },
  snapshot: () => ({ status: 'authorizing' }),
})
let authError = ''
try {
  await authorizing.load({ limit: 10, timeoutMs: 1000 })
} catch (error) {
  authError = error instanceof Error ? error.message : String(error)
}
check('points at the connection, not at tool permissions', authError.includes('连接尚未就绪'), authError)
check('names the state', authError.includes('authorizing'), authError)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

# dsh-plugin-atlassian

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.md) · **English**

Bridges **Atlassian's official remote MCP server** into
[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh). After a single browser
authorization, the Jira, Confluence, Jira Service Management, Bitbucket and Compass tools appear as
native tools in the agent's tool list:

```
mcp__atlassian__getJiraIssue
mcp__atlassian__createJiraIssue
mcp__atlassian__searchConfluenceUsingCql
```

![Settings → Atlassian](assets/settings-page.png)

The DSH built-in `dsh-mcp-client` has no OAuth support, and API-token auth forces an explicit
`cloudId` on every tool call. This plugin supplies the missing piece over OAuth 2.1 — the site
follows from the authorization, so no `cloudId` is ever passed.

## Supported Harness versions

The target runtime is **DeepSeek Harness 0.2.0-rc.2**. The plugin declares a peer range on
`@deepseek-ai/dsh-tools` that spans 0.1.x and 0.2.x; DSH validates `@deepseek-ai/dsh-*` peers with
`includePrerelease`, so the package installs on both lines.

## Install

```sh
dsh plugin --profile desktop add https://github.com/zhenyong97/dsh-plugin-atlassian/releases/latest/download/dsh-plugin-atlassian.tgz
```

**Restart that profile afterwards.** Replace `desktop` with the profile you actually use.

That installs the **prebuilt** package from the release: the `.tgz` already carries the compiled
`lib/`, so no build runs and pnpm's build-script block never comes up. To install from source and
build it yourself, use the repository spec instead:

```sh
dsh plugin --profile desktop add github:zhenyong97/dsh-plugin-atlassian
```

(The source spec runs the `prepare` build, which pnpm blocks by default — it prints the exact key to
add under `allowBuilds` in that profile's `pnpm-workspace.yaml`.)

## Connect Atlassian

1. Open **Settings → Atlassian**
2. Click **Connect Atlassian**
3. Approve the request on Atlassian's authorization page, **choosing the site to authorize**
4. The status becomes **Connected**, and Settings lists the site and the tools it exposes

![The entry in the settings nav](assets/settings-nav.png)

The settings page at the top of this README is that connected state: the site row shows whichever site
you authorized, and the tool count on this machine was 32. If the authorization page does not open by
itself, Settings shows a clickable authorization link. If the flow gets stuck, click **Disconnect**
and reconnect.

Once connected, just ask the agent in plain language:

- "List the open issues assigned to me in the PROJ project"
- "Break this requirement into 5 subtasks under PROJ-123"
- "Write up these meeting notes as a Confluence page in the Engineering space"
- "Find Confluence pages tagged release-notes and summarise this week's changes"

## How to use it

### 1. Open the Jira board

After authorizing, the sidebar gains a Jira icon; click it to open the board. It reads the same MCP
connection, so it needs no extra token or cloudId configuration:

![The Jira board](assets/jira-board.png)

- **Columns are statuses.** Every Jira status is a column, ordered by status category (to do → in
  progress → done); within a category they are ordered by name, so a refresh never reshuffles the
  columns.
- **Filter by project.** The project chips are derived from the issues the current query actually
  returned, each carrying its count — so clicking one cannot land on an empty project. Click again
  to clear it, or use **Clear filters** to reset everything at once.
- **Filter by status category.** The to do / in progress / done chips carry counts too, and combine
  with the project filter as AND.
- **Assigned to me.** The **Assignee → Me** toggle folds `assignee = currentUser()` into the JQL, so
  the server does the filtering — it does not sift the 50 issues already loaded. The board fetches one
  page per refresh, so filtering that page would report "nothing assigned to me" to someone whose
  work simply is not on it. The toggle carries no count on purpose: it changes the query, so a truthful
  number would cost another round-trip, and a number derived from the loaded page would just be wrong.
- **The search box** matches substrings in the key, the summary and the project name, entirely
  client-side, so it issues no requests.
- **View switch.** "In progress" excludes completed issues (the default, so a long backlog cannot
  bury the work in flight); "All" includes them.
- **The JQL is shown and editable**, and takes effect on Enter — the JQL *is* the board's real
  state, and hiding it turns "the issue count looks wrong" into a bug report. Once edited, a
  **Reset** appears to return to the selected view.
- The status spine down the left of each card, the project chip at its foot, and the totals in the
  header are all there to be read at a glance.
- The board refreshes itself every 60 seconds, skipping while the page is hidden; the footer says
  whether the per-fetch limit was reached.

### 2. Read an issue and confirm a transition

**Click any card** and the drawer opens on the right: the description (rendered Markdown), priority,
assignee, project, and the **status transitions the server currently offers** — the buttons are
exactly what the server returned, never a guess. The drawer header is sticky, so the buttons stay
reachable while you scroll a long description.

![The issue drawer and its transitions](assets/board-detail.png)

A transition is applied when you confirm it in the drawer; the agent side is explicitly told not to
change issue status on its own.

### 3. Hand an issue to an agent

**Right-click any card** to open the menu and choose a destination in place:

![The hand-over menu](assets/board-handoff.png)

| Menu item | What it does |
|---|---|
| **New session (current workspace)** | Opens a session in the current / most recent workspace and delivers there |
| **Send to current session** | Queues into the session you already have open, without interrupting what it is doing |
| **Expand a workspace → ＋ New session** | Opens a session in that workspace and delivers there |
| **Expand a workspace → a session** | Delivers into that existing session (running ones first) |
| **Copy prompt** | Copies to the clipboard only; you decide where it goes |

Delivery leaves you **on the board** with the confirmation in place, so you can hand over the next
batch straight away; the target session is one click away in the sidebar.

The instruction comes from `board.promptTemplate` (`{{key}}` / `{{summary}}` are substituted). The
built-in template is deliberately constrained: read the code before editing, change only what this
task needs, show checkable evidence, and **explicitly tell the agent not to change the Jira workflow
itself** — status transitions stay your call on the board. A custom template is written per issue,
so a batch hand-over generates one per issue.

### 4. Select several and hand them over in one go

`Shift+click` selects the range from the previous card, in the order you see them (left to right,
top to bottom). As soon as anything is selected, the cards grow checkboxes and a batch bar appears
at the foot of the panel:

![Multi-select and the batch bar](assets/board-selection.png)

Several issues can go to the same session, or into a new one — they are combined into **one** prompt
rather than several interleaved ones.

Cards can also be dragged onto the Jira icon in the sidebar: dropping them selects the issues you
dragged and opens the same menu for you to confirm the target.

## Tools you will get

After authorizing, these appear in the agent's tool list as `mcp__atlassian__<name>`. Which ones are
actually available depends on the products you can reach on the site you authorized:

| Tool | Purpose |
|---|---|
| `searchJiraIssuesUsingJql` | Search issues with JQL |
| `getJiraIssue` | Read a single issue |
| `createJiraIssue` | Create an issue |
| `getVisibleJiraProjects` | List the Jira projects you can see |
| `getTransitionsForJiraIssue` | List the available status transitions for an issue |
| `searchConfluenceUsingCql` | Search Confluence with CQL |
| `getConfluencePage` | Read a page |
| `createConfluencePage` / `updateConfluencePage` | Create / update a page |
| `atlassianUserInfo` | The authorized account |
| `getAccessibleAtlassianResources` | The sites this authorization can reach |

## Configuration

The defaults work out of the box. To change one, override by `id: atlassian` in your profile's
`cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `atlassian` | Tool-name prefix: `mcp__<serverName>__<tool>` |
| `redirectPort` | `3334` | OAuth callback port — keep it stable |
| `expectedSite` | empty | When set, the authorized site is checked and a mismatch reported |
| `autoOpenBrowser` | `true` | Open the browser when **Connect Atlassian** is clicked |
| `board.jql` | empty | JQL the board opens with; empty selects the built-in "in progress" view (excludes done) |
| `board.limit` | `50` | Issues fetched per refresh (the server caps a page at 100) |
| `board.timeoutMs` | `90000` | Deadline for one board read |
| `board.promptTemplate` | empty | Instruction sent when an issue is handed to an agent; empty selects the built-in template |

Remaining fields and the full defaults are in `cordis.patch.yml`.

> ⚠️ A patch **replaces the row's whole `config`** rather than merging, so restate the other
> fields when you override.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-plugin-atlassian
```

The stored authorization lives in `$DSH_HOME/.dsh-atlassian/` — delete it too.

## Troubleshooting

<details>
<summary>No Atlassian page in Settings</summary>

The profile has no web server service, or the plugin did not take effect with the profile restart.
Look for warnings prefixed with `atlassian:` in the startup log.
</details>

<details>
<summary>Stuck at "Authorization required" / the browser never opened</summary>

Use the authorization link shown in Settings. If `redirectPort` is taken, the plugin falls back to
a temporary port and re-registers automatically. If the flow is truly stuck, click **Disconnect**
to clear the token and reconnect.
</details>

<details>
<summary>Connected, but the tool count is 0</summary>

The server returned no tools, usually a site permission issue — confirm the site you authorized
gives access to the products you expect.
</details>

<details>
<summary>Settings reports a site mismatch</summary>

The `expectedSite` you configured does not match the site actually authorized. The tools still
work; they just point at the site Settings shows. Fix `expectedSite` or re-authorize. **This is a
notice, not a block.**
</details>

## Known limitations

- Tools only — MCP Resources and Prompts are not supported yet
- Image results render as placeholder text
- The Settings nav icon is patched in place (DSH exposes no icon interface); if the patch does not
  match, the default gear stays
- A `expectedSite` mismatch is not a hard block

## Development

```sh
npm install && npm run build   # tsc(host) + tsc(client) + bundle the client
```

Verifying on a scratch profile, the two regression scripts, and the README / storefront capture flow
are covered in `dev/README.md`.

## License

MIT

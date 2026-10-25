# dsh-plugin-atlassian

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.md) · **English**

Bridges **Atlassian's official remote MCP server** into
[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh). After a single browser
authorization, tools for Jira, Confluence, Bitbucket, Goals, Projects, Loom and more appear as
native tools in the agent's tool list:

```
mcp__atlassian__getJiraIssue
mcp__atlassian__createJiraIssue
mcp__atlassian__searchConfluence
```

![Settings → Atlassian](assets/settings-page.png)

The DSH built-in `dsh-mcp-client` has no OAuth support, and API-token auth forces an explicit
`cloudId` on every tool call. This plugin supplies the missing piece over OAuth 2.1 — the site
follows from the authorization, so no `cloudId` is ever passed.

The plugin speaks Atlassian MCP **v2** over **two connections**:

| Connection | Endpoint | Purpose | Registered for the agent |
|---|---|---|---|
| model | `https://mcp.atlassian.com/v2/mcp` | v2 default: a small primary tool set plus `discover` / `executeRead` / `executeWrite` / `executeDestructive` | **yes** |
| board | `https://mcp.atlassian.com/v2/mcp?tools=all` | the paginated flat catalogue; the Jira board calls those raw names directly | **no** |

The split exists because the flat catalogue holds 200+ tool definitions: registering all of them
spends tens of thousands of context tokens on *every* request. The model now sees the dozen or so
primary tools, the board still reaches the whole catalogue, and both connections share one
authorization (same OAuth resource, only the query differs).

The cost: non-primary capabilities (`searchConfluence`, `listJiraIssueTransitions`, …) are not
callable by name from the model — it has to go through `discover` and then `executeRead` /
`executeWrite`. To restore the old "register everything" behaviour, set `boardUrl` equal to `url` and
put `?tools=all` back on `url`.

v2 is a **separate OAuth resource**: its authorization server is `auth.atlassian.com/<id>`, and a v1
client registration or token cannot be reused. Session files are keyed by URL, so the old one is
kept; you just need to click **Connect Atlassian** once after upgrading. The key also moved from
`…?tools=all` to `…/v2/mcp`, so upgrading from the single-connection release needs one
re-authorization too.

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
5. Click **View tools** to expand the catalogue, then search or read each tool's name and the
   description Atlassian supplied for it
6. At any later point, click **Test connection** to verify the current token is still accepted

![The entry in the settings nav](assets/settings-nav.png)

The settings page at the top of this README is that connected state: the site row shows whichever site
you authorized, and the tool count depends on the products that site exposes. If the authorization
page does not open by itself, Settings shows a clickable authorization link.

**Disconnect** is not a sign-out: it only withdraws this generation of tools from the agent's tool list
(the status becomes **Disconnected**) and leaves the authorization on disk. Clicking **Reconnect**
afterwards rebuilds both MCP sessions from the stored tokens and re-registers the tools, with **no
second browser round-trip**. Signing out is the separate **Sign out** button beside it — that is the one
that clears the local authorization and tokens, so the next connect has to authorize again. The
disconnected state is persisted: restarting the harness does not quietly put the tools back.

The tool catalogue loads on demand, so it never slows the status poll that runs every few seconds.
The names are the same ones the agent sees (`mcp__atlassian__...`), and the descriptions are passed
through verbatim from the MCP server, which makes the list useful for checking whether a capability
exists and how it should be called.

The **Sidebar entry** switch at the bottom of the page controls whether the sidebar shows the Jira
icon. Turning it off withdraws the icon and the board panel it opens together; board data and the
agent tools are unaffected, and the switch can be turned back on at any time. The choice lives in the
profile (`.dsh-atlassian/atlassian-prefs.json`), survives a restart, and is **not** reset by
disconnecting.

**Test connection** does not read a locally recorded expiry time: it makes one real authenticated
read-only call over the existing MCP connection (`getAccessibleAtlassianResources`, then
`atlassianUserInfo`, then `tools/list`). So:

- Expired access token but a usable refresh token → the SDK refreshes transparently and the page says
  **Token refreshed**
- Both dead (401 / `invalid_grant`) → the local tokens are cleared, the registered tools are
  unregistered, and the page asks you to reconnect
- A network failure or an Atlassian 5xx → only **Could not verify**; the authorization is left alone

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
- **The project row is Jira's own "recent" idea.** A site holds far more projects than a row can show
  (this one lists 148), so the row carries only: every **pinned** project in pin order; then the
  **recently opened** ones, newest first (at most 8); plus the **current selection**, which is visible
  even when it is neither pinned nor recent. Everything else lives behind the **更多项目 · N** picker at
  the end of the row, which searches by key or name and leads with the site's own
  `lastIssueUpdateTime` — "what changed lately" beats an alphabetical wall. The project **is** the
  board's scope, so there is no "All" entry and the count beside a chip is that project's real issue
  count. The recent list lives in the profile's `.dsh-atlassian/atlassian-prefs.json`.
- **Pinned projects.** Each project chip carries its own pin button (hollow dot → filled dot) on its
  right: clicking it **appends** the project to the front of the row, so several pins line up in the
  order you clicked them, and clicking again removes the pin. A pin reorders the row only — it does
  not hide a project or trigger a filter.
- **Filter by status category.** The to do / in progress / done chips carry counts too, and combine
  with the project scope as AND.
- **Assigned to me.** The **Assignee → Me** toggle folds `assignee = currentUser()` into the JQL, so
  the server does the filtering — it does not sift the issues already loaded. Each read pages through
  the current project until the server says it is complete (100 per request), so the toggle's answer
  does not depend on how large the project is. The toggle carries no count on purpose: it changes the
  query, so a truthful number would cost another round-trip.
- **The search box** matches substrings in the key, the summary and the project name, entirely
  client-side, so it issues no requests. The board only holds the current project's issues, though, so
  **typing
  `HMHP-111` or pasting a Jira link and pressing Enter** switches to an exact lookup by key on the
  server: an issue from another page, or excluded by the current filters, opens just the same —
  with its drawer, its transitions, and the hand-over actions. The looked-up issue is shown as one
  extra card and outranks the filter chips; clearing the box or pressing `Esc` puts it away.
- **View switch.** "In progress" excludes completed issues (the default, so a long backlog cannot
  bury the work in flight); "All" includes them.
- **The JQL is shown and editable**, and takes effect on Enter — the JQL *is* the board's real
  state, and hiding it turns "the issue count looks wrong" into a bug report. Once edited, a
  **Reset** appears to return to the selected view.
- The status spine down the left of each card, the project chip at its foot, and the totals in the
  header are all there to be read at a glance.
- **The board follows the theme.** Text, borders, card fills and status colours come from the
  Harness theme variables, so dark mode never produces dark-on-dark text; card hover, scrollbars and
  the keyboard focus ring are drawn for the active theme too.
- The board refreshes itself every 60 seconds, skipping while the page is hidden; **Refresh** also
  re-reads the project list, so a project created elsewhere becomes selectable without a reload. The
  footer only speaks up when the safety ceiling was actually reached.
- **The project scope is visible in the JQL**: the row shown carries `project = <KEY>`. Hand-editing
  it into a multi-project query (`project in (A, B)`) stops the chip from claiming a single project —
  the query is the truth. The single-project form (`project = A`) is rewritten by the chip.
- **Opening it again does not reload it.** Leaving for another panel or for Settings and coming back
  shows the same board: data younger than a minute is reused outright, older data is painted first
  and revalidated in the background, and only the first open waits. The view and the filters come
  back with it. A failed background refresh only marks **sync failed** in the header instead of
  replacing a readable board with an error page; disconnecting drops the cache and returns the
  connect prompt.
- **Clicking the title refreshes.** The whole "Jira board" identity block at the top left is a
  button: a click re-reads the board immediately (same path as the toolbar's **Refresh**), and the
  timestamp grows a **refreshing…** suffix while it runs — so caching does not leave you without a
  way to ask for fresh data.

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

After authorizing, the primary tools listed by `url` (the default endpoint) appear in the agent's tool
list as `mcp__atlassian__<name>`. Everything else in `boardUrl` (the flat catalogue) is for the Jira
board only; Settings marks those entries **board only**. Which ones are actually available depends on
the products you can reach on the site you authorized:

| Tool | Purpose | Agent can call it |
|---|---|---|
| `searchJiraIssuesUsingJql` | Search issues with JQL | ✅ |
| `getJiraIssue` | Read a single issue | ✅ |
| `createJiraIssue` / `editJiraIssue` | Create / edit an issue | ✅ |
| `atlassianUserInfo` | The authorized account | ✅ |
| `getAccessibleAtlassianResources` | The sites this authorization can reach | ✅ |
| `discover` + `executeRead`/`executeWrite` | Reach every non-primary capability below | ✅ |
| `listJiraProjects` | List the Jira projects you can see | board only |
| `listJiraIssueTransitions` | List the available status transitions for an issue | board only |
| `getJiraBoardSprintData` | Sprint catalogue and filtering (v2 has no `listJiraBoards` / `listJiraBoardSprints`) | board only |
| `searchConfluence` / `getConfluenceContent` etc. | Confluence reads and writes | via `discover` |

> Which names count as primary is Atlassian's call and follows your site's permissions; trust the
> **board only** markers in the Settings tool list.

## Configuration

The defaults work out of the box. To change one, override by `id: atlassian` in your profile's
`cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `atlassian` | Tool-name prefix: `mcp__<serverName>__<tool>` |
| `url` | `https://mcp.atlassian.com/v2/mcp` | The **model** connection; the default endpoint lists only the primary tools, which is the smallest context |
| `boardUrl` | `https://mcp.atlassian.com/v2/mcp?tools=all` | The **board** connection; flat catalogue, never registered for the agent. Set it equal to `url` to register everything again |
| `redirectPort` | `3334` | OAuth callback port — keep it stable |
| `expectedSite` | empty | When set, the authorized site is checked and a mismatch reported |
| `autoOpenBrowser` | `true` | Open the browser when **Connect Atlassian** is clicked |
| `board.jql` | empty | JQL the board opens with; empty selects the built-in "in progress" view (excludes done) |
| `board.limit` | `5000` | A **safety ceiling**, not a page size: the board pages through the current project 100 at a time until the server reports it complete, and only stops here (and says so in the footer) |
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
a temporary port and re-registers automatically. If the flow is truly stuck, click **Disconnect** to
abort that attempt and then **Connect Atlassian** to start over; if the stored authorization itself is
broken (for example a changed `redirectPort` invalidated the client registration), click **Sign out**
to clear it and connect afresh. If the authorization page explicitly rejects the redirect, a site
admin must allowlist `http://127.0.0.1:<redirectPort>/callback` in Atlassian's domain settings (v2
may enforce a redirect allowlist).
</details>

<details>
<summary>Stuck at "Authorization required" after upgrading from v1</summary>

v2 is a separate OAuth resource, so a v1 client registration or token cannot be reused. Session
files are keyed by URL and the old one is left untouched; click **Connect Atlassian** once to
authorize against v2.
</details>

<details>
<summary>How do I know whether the token is still valid</summary>

Click **Test connection**. It makes a real authenticated call rather than reading a local expiry time;
only an explicit rejection (401 / `invalid_grant`) clears the authorization and asks you to reconnect.
A network failure or a 5xx reports "could not verify" and leaves the authorization alone.
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
- The plugin does not implement v2's `discover` → `execute*` orchestration: those four tools are
  handed to the model as ordinary tools and the model decides how to chain them, so a non-primary
  capability cannot be called by name
- If the board connection fails (moved endpoint, network), the agent keeps its tools but the panel
  falls back to the model's tool set, where projects, sprints and transitions are unavailable; the
  log carries a `board catalogue … is unavailable` line
- JSM tools only support API-token auth in v2; this plugin is OAuth-only, so JSM tools are not loaded

## Development

```sh
npm install && npm run build   # tsc(host) + tsc(client) + bundle the client
```

Verifying on a scratch profile, the four regression scripts, and the README / storefront capture flow
are covered in `dev/README.md`.

## License

MIT

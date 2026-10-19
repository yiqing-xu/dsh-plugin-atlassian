import z from '@deepseek-ai/schemastery'

/**
 * The `config:` block of this plugin's composition row.
 *
 * Everything here is deployment-owned: the row in `cordis.patch.yml` states it,
 * and the loader applies the schema below for anything omitted.
 */
export interface Config {
  /**
   * Namespace for the model-facing tool names. Every bridged tool appears as
   * `mcp__<serverName>__<rawName>`, matching `@deepseek-ai/dsh-mcp-client` so
   * the two can coexist and session history stays readable.
   */
  serverName: string
  /**
   * Atlassian remote MCP endpoint (Streamable HTTP).
   *
   * v2 exposes only a small primary tool set plus discover/execute unless the
   * flat catalogue is requested, so the default carries `?tools=all`: this
   * plugin bridges each `tools/list` entry to a native tool, and the Jira board
   * also calls the raw names directly.
   */
  url: string
  /**
   * Loopback port for the OAuth redirect URI. `0` picks a free port.
   *
   * Dynamic client registration binds the exact redirect URI, so a port that
   * changes between runs invalidates the stored registration and forces a new
   * one. Keep it fixed unless something else owns the port.
   */
  redirectPort: number
  /** Deadline for one `tools/call`, in milliseconds. */
  toolCallTimeoutMs: number
  /**
   * Site the user is expected to authorize, e.g. `acme.atlassian.net`.
   * Shown in Settings, and checked once authorization completes so a wrong
   * site produces a clear message instead of mysteriously empty tools.
   * Empty string disables the check.
   */
  expectedSite: string
  /** How long to wait for the browser to return an authorization code. */
  authorizationTimeoutMs: number
  /** Open the system browser automatically when authorization is required. */
  autoOpenBrowser: boolean
  /** Settings for the Jira board panel. */
  board: BoardConfig
}

/**
 * The board panel's deployment-owned defaults.
 *
 * `jql` is the important one: Atlassian refuses a wholly unconstrained search,
 * so the board always has *some* query, and this is the one it opens with. The
 * panel lets the user override it for the session; this value is what a fresh
 * visit starts from.
 */
export interface BoardConfig {
  /**
   * JQL the panel opens with.
   *
   * Empty selects the built-in default view — `updated >= -180d AND
   * statusCategory != Done`, i.e. work in flight — because a long backlog
   * otherwise buries the issues anyone is actually looking at. The panel's view
   * selector and JQL box change this for the session only.
   */
  jql: string
  /** Cap on issues fetched per refresh (server maximum is 100). */
  limit: number
  /**
   * Extra deadline for board reads, on top of `toolCallTimeoutMs`.
   *
   * A board read is a search plus the site-registry lookup on a cold start, so
   * it is allowed to run longer than a single model-facing tool call.
   */
  timeoutMs: number
  /**
   * Instruction sent to an agent when an issue is handed over.
   *
   * `{{key}}` and `{{summary}}` are substituted; an empty string selects the
   * built-in template. It is deliberately a full instruction rather than an
   * issue dump, because this is the plugin's chance to bound the delegated
   * work: Jira workflows must not be changed by an agent that cannot verify
   * the claim.
   */
  promptTemplate: string
  /**
   * Custom-field id of the sprint field, when it is not Jira's default
   * `sprint`.
   *
   * The board always asks for `sprint` BY NAME — v2 resolves that on every site
   * — and this id is requested alongside it, never instead of it, so a wrong
   * value cannot blind the sprint filter. It matters on sites that renamed the
   * field (where `sprint` answers nothing) or that run several sprint-like
   * fields. Example: `customfield_10020`.
   */
  sprintField: string
}

export const Config = z.object({
  serverName: z.string().default('atlassian'),
  url: z.string().default('https://mcp.atlassian.com/v2/mcp?tools=all'),
  redirectPort: z.number().step(1).min(0).max(65535).default(3334),
  toolCallTimeoutMs: z.number().step(1).min(1).default(60000),
  expectedSite: z.string().default(''),
  authorizationTimeoutMs: z.number().step(1).min(1000).default(300000),
  autoOpenBrowser: z.boolean().default(true),
  // Deliberately not `.default({})`: schemastery's object default needs every
  // key, and the per-field defaults below already make an omitted `board:`
  // block resolve to the full shape.
  board: z.object({
    jql: z.string().default(''),
    // A SAFETY CEILING, not a page size: the board pages through its query until
    // the server reports it complete, and only stops here. The default is far
    // above a normal project so the panel holds the whole thing; it exists only
    // so a site with tens of thousands of matching issues cannot hang the page.
    limit: z.number().step(1).min(1).default(5000),
    timeoutMs: z.number().step(1).min(1000).default(90000),
    promptTemplate: z.string().default(''),
    sprintField: z.string().default(''),
  }),
})

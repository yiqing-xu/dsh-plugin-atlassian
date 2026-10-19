import type { Context } from '@deepseek-ai/cordis'
import { AtlassianBridge } from './bridge.js'
import { createBoard, type JiraBoard } from './board.js'
import { Config, type Config as ConfigShape } from './config.js'
import { PreferenceStore, preferencesFileFor } from './prefs.js'
import { registerRoutes, type BoardRouteOptions, type RequestFence, type RouteRegistrar } from './routes.js'
import { SessionStore, sessionFileFor } from './store.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'atlassian'

/**
 * Only the tool registry is a hard dependency: without it there is nothing to
 * register into. The web server is read optionally (`ctx.get`) so the plugin
 * still works in a profile with no browser UI.
 */
export const inject = ['tools']

export { Config }

/** Minimal shape of the Cordis context surface this plugin touches. */
interface ServiceScope {
  get(service: string): unknown
  on?(event: string, listener: (...args: unknown[]) => void): (() => void) | undefined
}

/**
 * Connect a DSH profile to Atlassian's official remote MCP server.
 *
 * Activation deliberately does not wait for the connection: the first run has
 * to send the user to a browser, and blocking startup on a human would make
 * the profile look hung. The row activates immediately; tools appear as soon
 * as the connection is usable.
 *
 * @param ctx - Plugin context carrying the tool registry.
 * @param config - Resolved row configuration.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const store = new SessionStore(sessionFileFor(config.serverName, config.url))
  const bridge = new AtlassianBridge(
    {
      register: (definition) => ctx.tools.register(definition),
      logger: ctx.logger,
    },
    {
      serverName: config.serverName,
      url: config.url,
      redirectPort: config.redirectPort,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      expectedSite: config.expectedSite,
      authorizationTimeoutMs: config.authorizationTimeoutMs,
      autoOpenBrowser: config.autoOpenBrowser,
      store,
    },
  )

  const board = createBoard(bridge)

  // UI preferences live beside the OAuth session but outlive it: disconnecting
  // must not restore a hidden sidebar panel.
  const prefs = new PreferenceStore(preferencesFileFor(config.serverName))

  // One object shared by the route handler (which enforces the defaults) and
  // the client registration (which labels its UI with them), so the two can
  // never disagree about which JQL or limit is in force.
  const boardOptions: BoardRouteOptions = {
    jql: config.board.jql,
    limit: config.board.limit,
    timeoutMs: config.board.timeoutMs,
    promptTemplate: config.board.promptTemplate,
    sprintField: config.board.sprintField,
  }

  // Everything the bridge owns — the callback server, the transport, every
  // registered tool — is released here, so HMR replaces the row cleanly.
  ctx.effect(
    () => () => {
      void bridge.dispose()
    },
    'atlassian:bridge',
  )

  bindRoutes(ctx, bridge, board, boardOptions, prefs)

  void bridge.start().catch((error: unknown) => {
    ctx.logger.error(`atlassian: startup failed: ${String(error)}`)
  })
}

/**
 * Attach the Settings endpoints once a web server exists.
 *
 * The web server is provided by a sibling plugin row, and Cordis activates
 * rows concurrently — so at `apply` time it may simply not be there yet.
 * Reading it optionally and retrying on `internal/service` covers both orders;
 * a hard `inject` would instead keep this row dormant in every profile that
 * has no browser UI at all.
 */
function bindRoutes(
  ctx: Context,
  bridge: AtlassianBridge,
  board: JiraBoard,
  options: BoardRouteOptions,
  prefs: PreferenceStore,
): void {
  const scope = ctx as unknown as ServiceScope

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let fenced = false

    const attempt = (): void => {
      const web = (scope.get('webServer') ?? scope.get('httpServer')) as RouteRegistrar | undefined
      if (web === undefined) return
      // Resolved on every attempt, never once at `apply`: `connection` is
      // provided by another row and is routinely absent this early. Reading it
      // eagerly is what silently produced unfenced routes.
      const fence = scope.get('connection') as RequestFence | undefined
      // Already registered — upgrade in place once the fence shows up, and
      // otherwise leave the working registration alone.
      if (dispose !== undefined && (fenced || fence === undefined)) return

      const wasFenced = fenced
      dispose?.()
      dispose = registerRoutes(web, bridge, board, options, prefs, fence)
      fenced = fence !== undefined
      if (!wasFenced || fenced) {
        ctx.logger.info(
          `atlassian: endpoints registered${fenced ? '' : ' — the connection request fence is not available yet'}`,
        )
      }
    }

    attempt()
    if (dispose === undefined) {
      ctx.logger.warn(
        'atlassian: no web server service yet — the Settings page will not appear until one is available',
      )
    }
    const off = scope.on?.('internal/service', () => {
      attempt()
    })

    return () => {
      off?.()
      dispose?.()
      dispose = undefined
    }
  }, 'atlassian:routes')
}

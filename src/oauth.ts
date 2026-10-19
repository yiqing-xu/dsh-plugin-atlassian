import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { SessionStore } from './store.js'

/** Minimal logging surface; the Cordis logger satisfies it structurally. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The authorization code the browser handed back, plus the state it carried. */
export interface AuthorizationCallback {
  code: string
  state: string | undefined
}

/**
 * The loopback endpoint the authorization server redirects to.
 *
 * A local HTTP server is the only redirect target a desktop OAuth client can
 * offer: the authorization server must reach it, so it must be a real socket,
 * and RFC 8252 makes loopback the sanctioned shape. It listens on `127.0.0.1`
 * only — never a routable interface — and lives only as long as the plugin,
 * answering exactly one path.
 */
export class CallbackServer {
  #server: Server | undefined
  #port = 0
  #waiter: { resolve: (value: AuthorizationCallback) => void; reject: (error: Error) => void } | undefined
  #timer: NodeJS.Timeout | undefined

  /** The URI dynamic client registration binds. Valid only after `listen`. */
  get redirectUri(): string {
    return `http://127.0.0.1:${this.#port}/callback`
  }

  /**
   * Bind the loopback port.
   *
   * @param preferredPort - Port to try first; `0` asks the OS for a free one.
   * @returns The port actually bound.
   */
  async listen(preferredPort: number): Promise<number> {
    if (this.#server !== undefined) return this.#port
    const server = createServer((req, res) => {
      void this.#handle(req.url ?? '/', res)
    })
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error)
      }
      server.once('error', onError)
      server.listen(preferredPort, '127.0.0.1', () => {
        server.off('error', onError)
        resolve((server.address() as AddressInfo).port)
      })
    }).catch(async (error: NodeJS.ErrnoException) => {
      // A busy preferred port is not worth failing over: an ephemeral port is
      // fine as long as the URI is registered before use.
      if (error.code !== 'EADDRINUSE' || preferredPort === 0) throw error
      return await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as AddressInfo).port)
        })
      })
    })
    server.on('error', () => {
      // Post-listen errors surface through the waiter, not as unhandled events.
    })
    this.#server = server
    this.#port = port
    return port
  }

  /**
   * Resolve with the next authorization code delivered to `/callback`.
   *
   * Re-armed per attempt: a timed-out or rejected wait leaves the server
   * listening, so a retry works without rebinding the port.
   *
   * @param timeoutMs - How long to wait before rejecting.
   * @param expectedState - State the redirect must carry, when one was issued.
   * @param signal - Optional cancellation.
   */
  waitForCode(
    timeoutMs: number,
    expectedState: string | undefined,
    signal?: AbortSignal,
  ): Promise<AuthorizationCallback> {
    this.cancelWait()
    return new Promise<AuthorizationCallback>((resolve, reject) => {
      const finish = (): void => {
        if (this.#timer !== undefined) clearTimeout(this.#timer)
        this.#timer = undefined
        this.#waiter = undefined
        signal?.removeEventListener('abort', onAbort)
      }
      const succeed = (value: AuthorizationCallback): void => {
        finish()
        resolve(value)
      }
      const fail = (error: Error): void => {
        finish()
        reject(error)
      }
      const onAbort = (): void => fail(new Error('authorization cancelled'))
      this.#waiter = { resolve: succeed, reject: fail }
      this.#pendingState = expectedState
      if (signal !== undefined) {
        if (signal.aborted) {
          fail(new Error('authorization cancelled'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#timer = setTimeout(() => {
        fail(new Error(`authorization timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.#timer.unref()
    })
  }

  /** Drop any pending wait without stopping the server. */
  cancelWait(): void {
    const waiter = this.#waiter
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#waiter = undefined
    waiter?.reject(new Error('authorization superseded by a newer attempt'))
  }

  /** Stop listening and reject any pending wait. */
  async close(): Promise<void> {
    this.cancelWait()
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Sockets the browser keeps alive would otherwise hold close() open.
      server.closeAllConnections?.()
    })
  }

  #pendingState: string | undefined

  async #handle(url: string, res: import('node:http').ServerResponse): Promise<void> {
    const parsed = new URL(url, 'http://127.0.0.1')
    if (parsed.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const error = parsed.searchParams.get('error')
    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state') ?? undefined

    const waiter = this.#waiter
    if (error !== null) {
      const description = parsed.searchParams.get('error_description') ?? error
      this.#respond(res, false, `授权失败：${description}`)
      waiter?.reject(new Error(`authorization failed: ${description}`))
      return
    }
    if (code === null || code === '') {
      this.#respond(res, false, '回调缺少授权码。')
      waiter?.reject(new Error('authorization callback carried no code'))
      return
    }
    if (this.#pendingState !== undefined && state !== this.#pendingState) {
      this.#respond(res, false, 'state 校验失败，已拒绝本次授权。')
      waiter?.reject(new Error('authorization callback state did not match the issued state'))
      return
    }
    this.#respond(res, true, '授权完成，可以回到 DeepSeek Harness 了。')
    waiter?.resolve({ code, state })
  }

  #respond(res: import('node:http').ServerResponse, ok: boolean, message: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Atlassian</title>` +
        `<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:32rem;text-align:center">` +
        `<h1 style="font-size:1.4rem">${ok ? '✅ 已连接' : '⚠️ 未完成'}</h1>` +
        `<p>${message}</p><p style="color:#888;font-size:.85rem">dsh-plugin-atlassian</p></body>`,
    )
  }
}

/** Options the provider needs from the plugin. */
export interface AtlassianOAuthOptions {
  /**
   * The registered redirect URI (from {@link CallbackServer.redirectUri}).
   *
   * A thunk, not a value: the provider is constructed before the callback
   * server has bound its port, and the SDK may read `redirectUrl` on either
   * side of that moment.
   */
  redirectUri: () => string
  /** Persisted OAuth state. */
  store: SessionStore
  /** Called once with the URL the user must visit, before the browser opens. */
  onAuthorizationUrl: (url: string) => void
  logger: Logger
}

/**
 * The MCP SDK's OAuth 2.1 client, backed by the on-disk session store.
 *
 * The SDK owns discovery, dynamic client registration, PKCE and token
 * exchange; this class owns the three things it cannot know: where the tokens
 * live, what the redirect URI is, and how to get a human in front of the
 * authorization page.
 *
 * v2 points its protected-resource metadata at a per-resource authorization
 * server (`auth.atlassian.com/<id>`) with its own DCR endpoint. The SDK follows
 * that metadata, so a v1 registration is never reused — and because the session
 * file is keyed by URL, the two endpoints cannot share one either.
 *
 * Note there is no `scope` in `clientMetadata`. v2 publishes `scopes_supported`
 * in the protected-resource metadata, and the MCP SDK requests exactly that
 * set; that is what lets the flat `?tools=all` catalogue load every product the
 * user consented to. v1 published no scopes, so it requested none.
 */
export class AtlassianOAuthProvider implements OAuthClientProvider {
  readonly #options: AtlassianOAuthOptions

  constructor(options: AtlassianOAuthOptions) {
    this.#options = options
  }

  get redirectUrl(): string {
    return this.#options.redirectUri()
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DeepSeek Harness (dsh-plugin-atlassian)',
      redirect_uris: [this.#options.redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  /** A fresh CSRF state per authorization attempt. */
  state(): string {
    return randomBytes(16).toString('hex')
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#options.store.current.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.#options.store.patch({ clientInformation })
  }

  tokens(): OAuthTokens | undefined {
    return this.#options.store.current.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#options.store.patch({ tokens })
  }

  /**
   * Surface the authorization URL to the user.
   *
   * The transport calls this from inside `connect()`, before it throws
   * `UnauthorizedError` — so by the time the caller sees the failure, the URL
   * is already published to the UI and the log. Opening the browser is the
   * caller's decision, not this method's; the SDK contract is only "the user
   * agent has been sent here".
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.#options.logger.info(
      `atlassian: authorization required — open ${authorizationUrl.toString()}`,
    )
    this.#options.onAuthorizationUrl(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.#options.store.patch({ codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.#options.store.current.codeVerifier
    if (verifier === undefined) {
      throw new Error('atlassian: no PKCE code verifier is stored for this session')
    }
    return verifier
  }

  /**
   * Drop cached credentials so the next attempt starts clean.
   *
   * The SDK calls this when the server rejects the client (`all`), the client
   * registration (`client`), or the grant (`tokens`) — each scope clears only
   * what is genuinely invalid, so a refresh-token expiry does not also throw
   * away a perfectly good client registration.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    switch (scope) {
      case 'all':
        await this.#options.store.clear('tokens', 'clientInformation', 'codeVerifier')
        return
      case 'client':
        await this.#options.store.clear('clientInformation')
        return
      case 'tokens':
        await this.#options.store.clear('tokens')
        return
      case 'verifier':
        await this.#options.store.clear('codeVerifier')
        return
      case 'discovery':
        // Discovery is re-run on demand; nothing is cached across attempts.
        return
    }
  }
}

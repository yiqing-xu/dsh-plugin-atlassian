import { spawn } from 'node:child_process'

/**
 * The platform command that hands a URL to the desktop's default handler.
 *
 * ## Windows: why the URL must be a quoted literal *and* verbatim
 *
 * The natural spelling — `cmd /c start "" <url>` — is broken for any URL with
 * more than one query parameter, because **`cmd.exe` treats `&` as a command
 * separator**. It splits the URL at the first `&` and runs the rest as
 * commands:
 *
 * ```
 * in : https://auth.example.com/authorize?response_type=code&client_id=ABC&state=XYZ
 * out: https://auth.example.com/authorize?response_type=code
 *      'client_id' is not recognized as an internal or external command
 * ```
 *
 * An OAuth authorize URL is exactly that shape, so the browser landed on the
 * endpoint with no `client_id`, no PKCE challenge and no state.
 *
 * Two things together fix it, and both are required:
 *
 * 1. the URL is wrapped in double quotes, which is what keeps `&` away from
 *    cmd's parser; and
 * 2. `windowsVerbatimArguments` makes Node pass the argv through untouched —
 *    with the default quoting, Node rewrites the command line and undoes (1).
 *
 * Verified by loopback probe: the browser's request line carried all four
 * query parameters intact. The same probe rejected the alternatives —
 * `powershell Start-Process '<url>'` exits 0 without opening anything, which
 * is exactly the kind of silent no-op that would have shipped as "fixed".
 *
 * `open` (macOS) and `xdg-open` (Linux) receive the URL as plain argv with no
 * shell involved, so `&` is already inert there.
 */
function openerFor(url: string): { command: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    // A double quote cannot appear literally in a URL produced by
    // `URL.toString()`, but this runs through a command interpreter, so the
    // one character that could break out of the quoting is neutralised rather
    // than trusted.
    const literal = `"${url.replace(/"/g, '%22')}"`
    return { command: 'cmd', args: ['/c', 'start', '""', literal], verbatim: true }
  }
  if (process.platform === 'darwin') return { command: 'open', args: [url], verbatim: false }
  return { command: 'xdg-open', args: [url], verbatim: false }
}

/**
 * Hand a URL to the operating system's default handler.
 *
 * `@deepseek-ai/dsh-host-open-in-app` is not usable here: it opens *directories*
 * in catalogued editors, and its catalog has no URL entry. A direct spawn of
 * the platform opener is the smallest thing that works everywhere — provided
 * the opener is spelled as above.
 *
 * The child is detached with its stdio dropped, so a launcher that stays in the
 * foreground cannot hold this process open. A failure is the caller's to
 * ignore: opening the browser is a convenience, and the authorization URL is
 * always published in Settings and in the log as well.
 *
 * @param url - Absolute URL to open.
 * @returns true when the opener ran; false when it failed immediately.
 */
export function openInBrowser(url: string): Promise<boolean> {
  const { command, args, verbatim } = openerFor(url)

  return new Promise((resolve) => {
    let settled = false
    let watch: NodeJS.Timeout | undefined
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      if (watch !== undefined) clearTimeout(watch)
      resolve(value)
    }
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      })
      child.on('error', () => settle(false))
      // `start` hands off to the shell and returns at once; a non-zero exit
      // means it never got that far.
      child.on('exit', (code) => settle(code === 0 || code === null))
      child.unref()
      // A launcher still running after a beat counts as launched.
      watch = setTimeout(() => settle(true), 1500)
      watch.unref()
    } catch {
      settle(false)
    }
  })
}

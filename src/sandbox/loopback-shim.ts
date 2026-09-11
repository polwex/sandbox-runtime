/**
 * The Linux loopback shim: an in-sandbox HTTP proxy front end that routes a
 * loopback destination to the sandbox's own `127.0.0.1` when a server is
 * listening there, and to the host proxy otherwise.
 *
 * See `vendor/loopback-shim/shim.sh` for why both directions need it. This
 * module only locates the script and builds the `socat … EXEC:` listener that
 * runs it per connection — the lookup shape follows the java proxy agent jar
 * and the apply-seccomp binary, since the script has to be readable (and
 * executable) from inside the sandbox at the same absolute path.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logForDebugging } from '../utils/debug.js'
import { quote } from '../utils/shell-quote.js'
import { getGlobalNpmPaths } from './generate-seccomp-filter.js'

const LOOPBACK_SHIM_SCRIPT_NAME = 'shim.sh'

const RELATIVE_SCRIPT_PATH = join(
  'vendor',
  'loopback-shim',
  LOOPBACK_SHIM_SCRIPT_NAME,
)

const scriptPathCache = new Map<string, string | null>()

/**
 * Locate the loopback shim script. Order:
 * 0. explicit path — used if it exists (tests, or an embedder that ships the
 *    script itself),
 * 1. vendor/loopback-shim/ next to this module (bundled),
 * 2. ../../vendor/loopback-shim/ (package root — normal npm install),
 * 3. ../vendor/loopback-shim/ (dist/vendor — some bundlers),
 * 4. a global npm install of the package (native builds without vendor/).
 * Returns null when nothing is found; callers then keep the plain
 * `socat TCP-LISTEN` front end, which is the pre-shim behaviour.
 */
export function getLoopbackShimScriptPath(
  explicitPath?: string,
): string | null {
  const key = explicitPath ?? ''
  const cached = scriptPathCache.get(key)
  if (cached !== undefined) return cached
  const found = findScript(explicitPath)
  scriptPathCache.set(key, found)
  return found
}

function findScript(explicitPath?: string): string | null {
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath
    logForDebugging(
      `[loopback-shim] loopbackShimPath not found: ${explicitPath}`,
      {
        level: 'warn',
      },
    )
  }
  const baseDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(baseDir, RELATIVE_SCRIPT_PATH),
    join(baseDir, '..', '..', RELATIVE_SCRIPT_PATH),
    join(baseDir, '..', RELATIVE_SCRIPT_PATH),
    ...getGlobalNpmPaths().map(base => join(base, RELATIVE_SCRIPT_PATH)),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  logForDebugging(
    `[loopback-shim] ${LOOPBACK_SHIM_SCRIPT_NAME} not found; loopback ` +
      'destinations will not reach a server bound inside the sandbox',
    { level: 'warn' },
  )
  return null
}

/**
 * Build the in-sandbox socat listener for the shimmed HTTP proxy port, e.g.
 *
 *   SRT_SHIM_SELF_PORT=3128 SRT_SHIM_PARENT_SOCK=<sock> \
 *     socat TCP-LISTEN:3128,fork,reuseaddr EXEC:'bash /path/shim.sh'
 *     >/dev/null 2>&1 &
 *
 * The shell and the script path are argv words of `EXEC:`, which socat splits
 * on whitespace itself (no shell involved), so a path containing whitespace
 * cannot be expressed. That is rare enough to decline rather than mis-split:
 * the caller falls back to the plain listener, which is the pre-shim
 * behaviour (host-side loopback only).
 */
export function buildLoopbackShimListener(opts: {
  /** Port the shim listens on inside the sandbox. */
  localPort: number
  /** Parent proxy's Unix socket path, as seen inside the sandbox. */
  parentSocketPath: string
  /** Absolute path to shim.sh, inside the sandbox. */
  scriptPath: string
  /** In-sandbox shell to run it with (the same one the wrapped command uses). */
  shell: string
  /** socat binary to run, as seen inside the sandbox. */
  socatPath?: string
}): string | undefined {
  const { localPort, parentSocketPath, scriptPath, shell, socatPath } = opts
  for (const [what, value] of [
    ['shell', shell],
    ['script path', scriptPath],
  ] as const) {
    if (/\s/.test(value)) {
      logForDebugging(
        `[loopback-shim] ${what} contains whitespace (${JSON.stringify(value)}); ` +
          'using the plain proxy listener',
        { level: 'warn' },
      )
      return undefined
    }
  }
  return (
    `SRT_SHIM_SELF_PORT=${localPort} ` +
    `SRT_SHIM_PARENT_SOCK=${quote([parentSocketPath])} ` +
    `${quote([socatPath ?? 'socat'])} ` +
    `TCP-LISTEN:${localPort},fork,reuseaddr ` +
    // Quote the command line so the shell hands socat ONE argv word: socat
    // splits the EXEC value itself, and an unquoted space here would instead
    // read as a third address ("exactly 2 addresses required (there are 3)")
    // and the listener would never start.
    `EXEC:${quote([`${shell} ${scriptPath}`])} >/dev/null 2>&1 &`
  )
}

/**
 * bwrap mount points are created by the parent process.
 *
 * bwrap cannot bind over a path that does not exist, so protecting a
 * non-existent deny path (`.bashrc`, `.gitconfig`, … in the working
 * directory) needs a mount point on the host filesystem. Who creates it
 * matters: bwrap creates it from inside its own user namespace, where the
 * mapped uid may have no host mapping, in which case the artifact lands owned
 * by the overflow uid (`nobody`) and cannot be removed by the real user in a
 * sticky directory such as /tmp. One leaked artifact then blocks every later
 * sandbox in that directory with "Can't create file at <path>: Permission
 * denied" (observed on /tmp/.git/hooks). Creating it in the parent keeps
 * ownership — and therefore deletability — with the invoking user.
 */
import { describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLinux } from '../helpers/platform.js'

const REPO = join(import.meta.dir, '..', '..')
const SANDBOX_MANAGER = join(REPO, 'src', 'sandbox', 'sandbox-manager.js')

/** Protected dotfiles the sandbox stubs in the working directory. */
const STUBS = ['.bashrc', '.gitconfig', '.mcp.json', '.profile']

/**
 * Driver that wraps a command and reports when the wrapping is done. It
 * starts no sandboxed command, so what exists on disk at that point is
 * exactly what the parent created — bwrap has not run yet.
 */
function driverSource(settings: string): string {
  return `import { SandboxManager } from ${JSON.stringify(SANDBOX_MANAGER)}
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(${JSON.stringify(settings)}, 'utf8'))
await SandboxManager.initialize(cfg)
await SandboxManager.wrapWithSandbox('true')
console.log('ready')
setInterval(() => {}, 1000)
`
}

function startDriver(name: string): { dir: string; child: ChildProcess } {
  const dir = join(tmpdir(), `srt-mountpoints-${name}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const settings = join(dir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: ['.'],
        denyWrite: [],
      },
    }),
  )
  writeFileSync(join(dir, 'driver.ts'), driverSource(settings))
  const child = spawn('bun', ['driver.ts'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { dir, child }
}

describe.if(isLinux)('bwrap mount points', () => {
  it('exist before bwrap runs, owned by the invoking user', async () => {
    const { dir, child } = startDriver('owner')
    try {
      await once(child.stdout!, 'data')

      const uid = process.getuid?.()
      for (const name of STUBS) {
        const path = join(dir, name)
        expect(existsSync(path)).toBe(true)
        const st = statSync(path)
        expect(st.isFile()).toBe(true)
        expect(st.size).toBe(0)
        expect(st.uid).toBe(uid)
      }
    } finally {
      child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

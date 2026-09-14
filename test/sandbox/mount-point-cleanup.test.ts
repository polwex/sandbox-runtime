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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/**
 * Run one sandboxed command to completion inside `dir` and return its stdout.
 * Out of process because deny paths resolve against the wrapper's cwd, so an
 * in-process run would materialise placeholders in this repository.
 */
async function runSandboxed(
  name: string,
  filesystem: Record<string, unknown>,
  command: string,
  seed: Record<string, string> = {},
): Promise<{ dir: string; stdout: string }> {
  const dir = join(tmpdir(), `srt-mountpoints-${name}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(seed)) {
    writeFileSync(join(dir, file), content)
  }
  const settings = join(dir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem,
    }),
  )
  writeFileSync(
    join(dir, 'driver.ts'),
    `import { SandboxManager } from ${JSON.stringify(SANDBOX_MANAGER)}
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const cfg = JSON.parse(readFileSync(${JSON.stringify(settings)}, 'utf8'))
await SandboxManager.initialize(cfg)
const wrapped = await SandboxManager.wrapWithSandbox(${JSON.stringify(command)})
const child = spawn(wrapped, { shell: true, stdio: ['ignore', 'pipe', 'inherit'] })
child.stdout.pipe(process.stdout)
child.on('exit', code => process.exit(code ?? 0))
`,
  )
  const child = spawn('bun', ['driver.ts'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout!.on('data', d => (stdout += d))
  try {
    const [code] = (await once(child, 'exit')) as [number]
    expect(code).toBe(0)
    return { dir, stdout }
  } finally {
    child.kill('SIGKILL')
  }
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

  it('can be skipped entirely, leaving the working tree untouched', async () => {
    // The trade a caller makes with createMissingDenyPaths: false — the denied
    // paths that do not exist are simply not protected, so nothing is written
    // into the working tree. The command below plants one on purpose, which is
    // exactly what the default configuration prevents.
    const { dir, stdout } = await runSandboxed(
      'nomissing',
      {
        denyRead: [],
        allowRead: [],
        allowWrite: ['.'],
        denyWrite: [],
        createMissingDenyPaths: false,
      },
      'echo planted > .bashrc && cat .bashrc',
    )
    try {
      expect(stdout).toContain('planted')
      expect(readFileSync(join(dir, '.bashrc'), 'utf8').trim()).toBe('planted')
      // Nothing else materialised: no .mcp.json, .vscode, .idea, .claude, …
      expect(readdirSync(dir).sort()).toEqual([
        '.bashrc',
        'driver.ts',
        'settings.json',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('still denies a dangerous path that already exists when skipped', async () => {
    // The half that must NOT change: skipping placeholder creation only drops
    // the protection for paths that do not exist. An existing denied file is
    // bound over, so a write inside the sandbox never reaches it.
    const { dir } = await runSandboxed(
      'existing',
      {
        denyRead: [],
        allowRead: [],
        allowWrite: ['.'],
        denyWrite: [],
        createMissingDenyPaths: false,
      },
      'echo hacked > .mcp.json; cat .mcp.json; echo "---"',
      { '.mcp.json': '{"keep":true}' },
    )
    try {
      // On the host the file still holds its original content.
      expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe('{"keep":true}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

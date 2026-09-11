/**
 * The Linux loopback shim's routing decisions, driven as a real process:
 * the script is executed exactly as socat runs it (client bytes on stdin,
 * response on stdout) with a stub `socat` on PATH that records which backend
 * each stage asked for. No sandbox and no network are involved — the two
 * things under test are "which destination did the shim pick" and "did every
 * byte of the request reach it".
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isLinux } from '../helpers/platform.js'

const SHIM = join(
  import.meta.dir,
  '..',
  '..',
  'vendor',
  'loopback-shim',
  'shim.sh',
)
const PARENT_SOCK = '/tmp/srt-parent.sock'
const SELF_PORT = 3128

const WORK = join(tmpdir(), `srt-shim-test-${process.pid}`)
const STUB_DIR = join(WORK, 'bin')
const CALLS = join(WORK, 'calls')
const PROBE_OK_FILE = join(WORK, 'probe-ok')

/**
 * Stub socat. Two call shapes matter:
 *   - the connect probe: `-T 1 -u /dev/null TCP:127.0.0.1:<port>` — exit
 *     status decides whether a local server is considered reachable, so the
 *     test controls it via PROBE_OK_FILE;
 *   - either relay: `- <address>` — record the address, then echo stdin to
 *     stdout so the test can assert the request bytes were forwarded intact.
 */
function writeSocatStub(): void {
  writeFileSync(
    join(STUB_DIR, 'socat'),
    `#!/bin/sh
addr=''
for a in "$@"; do addr=$a; done
printf '%s\\n' "$*" >> ${JSON.stringify(CALLS)}
case "$*" in
  *-u*)
    [ -f ${JSON.stringify(PROBE_OK_FILE)} ] && exit 0
    exit 1
    ;;
esac
cat
`,
  )
  chmodSync(join(STUB_DIR, 'socat'), 0o755)
}

/** Run the shim as socat would, returning stdout and the recorded addresses. */
function runShim(
  request: string,
  opts: { localReachable: boolean },
): { out: string; calls: string[] } {
  if (opts.localReachable) writeFileSync(PROBE_OK_FILE, '')
  else rmSync(PROBE_OK_FILE, { force: true })
  rmSync(CALLS, { force: true })

  const r = spawnSync('bash', [SHIM], {
    input: request,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      SRT_SHIM_PARENT_SOCK: PARENT_SOCK,
      SRT_SHIM_SELF_PORT: String(SELF_PORT),
    },
    timeout: 10000,
  })
  const calls = readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean)
  return { out: r.stdout, calls }
}

/** The relay the shim actually streamed through, if any. */
function relayTarget(calls: string[]): string | undefined {
  const relay = calls.find(c => c.startsWith('- '))
  return relay?.slice(2)
}

describe.if(isLinux)('loopback shim', () => {
  beforeAll(() => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(STUB_DIR, { recursive: true })
    writeSocatStub()
  })

  afterAll(() => {
    rmSync(WORK, { recursive: true, force: true })
  })

  it('routes a CONNECT to the sandbox loopback when a server answers there', () => {
    const request =
      'CONNECT localhost:5173 HTTP/1.1\r\nHost: localhost:5173\r\n\r\n'
    const { calls } = runShim(request, { localReachable: true })

    expect(relayTarget(calls)).toBe('TCP:127.0.0.1:5173')
    expect(calls.some(c => c.includes(PARENT_SOCK))).toBe(false)
  })

  it('falls back to the host proxy when nothing listens on the sandbox loopback', () => {
    const request =
      'CONNECT localhost:5173 HTTP/1.1\r\nHost: localhost:5173\r\n\r\n'
    const { calls } = runShim(request, { localReachable: false })

    expect(relayTarget(calls)).toBe(`UNIX-CONNECT:${PARENT_SOCK}`)
  })

  it('routes an absolute-form request to the sandbox loopback by its URI port', () => {
    const request =
      'GET http://127.0.0.1:9005/upload HTTP/1.1\r\nHost: 127.0.0.1:9005\r\n\r\n'
    const { calls } = runShim(request, { localReachable: true })

    expect(relayTarget(calls)).toBe('TCP:127.0.0.1:9005')
  })

  it('completes a CONNECT tunnel to the sandbox loopback itself', () => {
    // A local HTTPS server expects a TLS ClientHello, not a CONNECT request:
    // the shim has to answer the CONNECT and relay what follows opaquely.
    const request =
      'CONNECT localhost:8961 HTTP/1.1\r\nHost: localhost:8961\r\n\r\n'
    const { out, calls } = runShim(request, { localReachable: true })

    expect(out).toBe('HTTP/1.1 200 Connection Established\r\n\r\n')
    expect(out).not.toContain('CONNECT')
    expect(relayTarget(calls)).toBe('TCP:127.0.0.1:8961')
  })

  it('leaves a CONNECT to the host proxy when nothing answers locally', () => {
    // The parent proxy owns the tunnel handshake for a host-side destination.
    const request =
      'CONNECT localhost:8961 HTTP/1.1\r\nHost: localhost:8961\r\n\r\n'
    const { out, calls } = runShim(request, { localReachable: false })

    expect(out).not.toContain('200 Connection Established')
    expect(relayTarget(calls)).toBe(`UNIX-CONNECT:${PARENT_SOCK}`)
    expect(out).toContain('CONNECT localhost:8961')
  })

  it('never dials a non-loopback destination locally', () => {
    const request =
      'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'
    const { calling = [], calls = [] } = {}
    const r = runShim(request, { localReachable: true })

    expect(r.calls.some(c => c.includes('TCP:127.0.0.1'))).toBe(false)
    expect(relayTarget(r.calls)).toBe(`UNIX-CONNECT:${PARENT_SOCK}`)
    void calling
    void calls
  })

  it('never dials its own port locally, which would recurse', () => {
    const request = `CONNECT 127.0.0.1:${SELF_PORT} HTTP/1.1\r\nHost: x\r\n\r\n`
    const { calls } = runShim(request, { localReachable: true })

    expect(relayTarget(calls)).toBe(`UNIX-CONNECT:${PARENT_SOCK}`)
  })

  it('handles a request with no explicit port as HTTP/80', () => {
    const request = 'GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n'
    const { calls } = runShim(request, { localReachable: true })

    expect(relayTarget(calls)).toBe('TCP:127.0.0.1:80')
  })

  it('forwards the request byte-for-byte, including a body after the head', () => {
    const body = 'x'.repeat(11)
    const request =
      'POST http://localhost:9005/upload HTTP/1.1\r\n' +
      'Host: localhost:9005\r\n' +
      `Content-Length: ${body.length}\r\n\r\n${body}`

    for (const localReachable of [true, false]) {
      const { out } = runShim(request, { localReachable })
      expect(out).toBe(request)
    }
  })

  it('sends a non-HTTP stream to the host proxy rather than guessing', () => {
    // No request line to parse: the shim must not treat the bytes as a
    // loopback destination, and must still forward them.
    const raw = '\x16\x03\x01\x00\x50not-http-at-all'
    const { calls, out } = runShim(raw, { localReachable: true })

    expect(relayTarget(calls)).toBe(`UNIX-CONNECT:${PARENT_SOCK}`)
    expect(out).toBe(raw)
  })
})

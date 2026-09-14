/**
 * The browser/credential relay (vendor/srt-proxy-relay).
 *
 * A client that cannot send proxy credentials — a browser pointed at the proxy
 * by a launch flag — gets a 407 on every request, so the relay attaches the
 * sandbox's per-session credential on its way through. These tests run the
 * relay against a stub "parent proxy" that *requires* that credential, so the
 * one thing that must never regress (the credential reaching the proxy) fails
 * loudly if it does. The CONNECT case also pins the read-ahead: bytes a client
 * sends immediately after its CONNECT arrive before the handshake is complete,
 * and dropping them breaks every TLS connection.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'

const RELAY = join(
  import.meta.dir,
  '..',
  '..',
  'vendor',
  'srt-proxy-relay',
  'srt-proxy-relay.mjs',
)
const USER = 'srt.tester'
const PASS = 'deadbeefcafe'
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

interface StubProxy {
  server: Server
  /** `proxy-authorization` values seen, one per request. */
  seenAuth: string[]
  /** Request targets seen (absolute-form URL, or CONNECT authority). */
  seenTargets: string[]
  port: number
  /** Port of a stand-in origin the CONNECT tunnel can reach. */
  originPort: number
  close: () => Promise<void>
}

/** A stand-in for srt's proxy: 407s anything without the session credential. */
async function startStubProxy(): Promise<StubProxy> {
  const seenAuth: string[] = []
  const seenTargets: string[] = []

  const origin = createServer((_req, res) => res.end('TUNNEL-ORIGIN'))
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')

  const server = createServer((req, res) => {
    seenAuth.push(req.headers['proxy-authorization'] ?? '<none>')
    seenTargets.push(req.url ?? '')
    if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) {
      res.writeHead(407).end('proxy auth required')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('VIA-PROXY')
  })

  server.on('connect', (req, clientSocket, head) => {
    seenAuth.push(req.headers['proxy-authorization'] ?? '<none>')
    seenTargets.push(req.url ?? '')
    if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) {
      // `end` rather than `destroy`, so the client can read the verdict.
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const [host, port] = String(req.url).split(':')
    const upstream = connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  return {
    server,
    seenAuth,
    seenTargets,
    port: (server.address() as { port: number }).port,
    originPort: (origin.address() as { port: number }).port,
    close: async () => {
      await new Promise<void>(r => origin.close(() => r()))
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

interface Relay {
  child: ChildProcess
  /** Port actually bound, read from the relay's banner (it is given `0`). */
  port: Promise<number>
  /** Pid of the supervised client, as reported once it has been started. */
  supervisedPid: Promise<number>
  /** Everything the supervised client wrote to stdout. */
  stdoutText: () => string
}

function startRelay(proxyPort: number, command: string[] = []): Relay {
  const child = spawn(
    'bun',
    [RELAY, '0', ...(command.length ? ['--', ...command] : [])],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HTTP_PROXY: `http://${USER}:${PASS}@127.0.0.1:${proxyPort}`,
      },
    },
  )
  const port = Promise.withResolvers<number>()
  const supervisedPid = Promise.withResolvers<number>()
  // Settled promises must not be rejected later: most relays exit on purpose
  // (the supervised client finishing), and an unawaited rejection would be
  // reported as an unhandled error rather than the test's own assertion.
  const settled = { port: false, supervisedPid: false }
  let out = ''
  let stdout = ''
  // Standalone, the relay reports on stdout — that is how a caller learns the
  // port a `0` argument bound. Supervising a client, it reports on stderr:
  // stdout belongs to that client (an MCP client's JSON-RPC stream).
  const report = command.length === 0 ? child.stdout! : child.stderr!
  child.stdout!.on('data', d => {
    stdout += d
  })
  report.on('data', d => {
    out += d
    const bound = out.match(/listening on 127\.0\.0\.1:(\d+)/)
    if (bound && !settled.port) {
      settled.port = true
      port.resolve(Number(bound[1]))
    }
    const supervised = out.match(/supervising pid=(\d+)/)
    if (supervised && !settled.supervisedPid) {
      settled.supervisedPid = true
      supervisedPid.resolve(Number(supervised[1]))
    }
  })
  child.once('exit', () => {
    const error = new Error(`relay exited early: ${out}`)
    if (!settled.port) {
      settled.port = true
      port.reject(error)
    }
    // Only when a client was expected: an unsupervised relay has none.
    if (command.length > 0 && !settled.supervisedPid) {
      settled.supervisedPid = true
      supervisedPid.reject(error)
    }
  })
  return {
    child,
    port: port.promise,
    supervisedPid: supervisedPid.promise,
    stdoutText: () => stdout,
  }
}

/** Whether a pid currently exists (signal 0 is a permission/existence probe). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read from a socket until the accumulated text satisfies `done`. */
async function readUntil(socket: Socket, done: (text: string) => boolean) {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let text = ''
  socket.on('data', chunk => {
    text += chunk.toString()
    if (done(text)) resolve(text)
  })
  socket.once('error', reject)
  socket.once('close', () => resolve(text))
  return promise
}

let relay: Relay | undefined
let stub: StubProxy | undefined

afterEach(async () => {
  relay?.child.kill('SIGKILL')
  relay = undefined
  await stub?.close()
  stub = undefined
})

describe('srt-proxy-relay', () => {
  it('adds the session credential to a plain HTTP request', async () => {
    stub = await startStubProxy()
    relay = startRelay(stub.port)
    const relayPort = await relay.port

    // Speak the proxy protocol directly (absolute-form request line at the
    // relay's port) rather than a client-specific proxy option, so the test
    // exercises what any proxy-unaware-of-credentials client would send.
    const answer = Promise.withResolvers<{ status: number; body: string }>()
    const request_ = request(
      {
        host: '127.0.0.1',
        port: relayPort,
        method: 'GET',
        path: 'http://example.invalid/thing',
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (body += chunk))
        res.on('end', () =>
          answer.resolve({ status: res.statusCode ?? 0, body }),
        )
      },
    )
    request_.on('error', answer.reject)
    request_.end()
    const { status, body } = await answer.promise

    expect(status).toBe(200)
    expect(body).toBe('VIA-PROXY')
    // The client sent no credential; the proxy saw ours, with the full URL.
    expect(stub.seenAuth).toEqual([EXPECTED_AUTH])
    expect(stub.seenTargets).toEqual(['http://example.invalid/thing'])
  }, 30000)

  it('completes a CONNECT tunnel and forwards its read-ahead bytes', async () => {
    stub = await startStubProxy()
    relay = startRelay(stub.port)
    const relayPort = await relay.port

    const socket = connect(relayPort, '127.0.0.1')
    await once(socket, 'connect')
    const target = `127.0.0.1:${stub.originPort}`
    // One write: the CONNECT and the first tunneled bytes arrive together, so
    // the trailing request is read ahead of the handshake.
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\nGET / HTTP/1.0\r\n\r\n`,
    )
    const received = await readUntil(socket, t => t.includes('TUNNEL-ORIGIN'))

    expect(received).toContain('200 Connection Established')
    expect(stub.seenAuth).toEqual([EXPECTED_AUTH])
    socket.destroy()
  }, 30000)

  it('passes a 407 back to the client instead of opening a dead tunnel', async () => {
    // A relay that answered the client's CONNECT before consulting the proxy
    // would turn a clear 407 (stale token) into a confusing mid-stream failure.
    stub = await startStubProxy()
    relay = startRelay(stub.port)
    const relayPort = await relay.port
    stub.server.removeAllListeners('connect')
    stub.server.on('connect', (_req, socket) =>
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'),
    )

    const socket = connect(relayPort, '127.0.0.1')
    await once(socket, 'connect')
    socket.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n')
    const received = await readUntil(socket, t => t.includes('\r\n\r\n'))

    expect(received).toContain('407')
    socket.destroy()
  }, 30000)

  it('exits with the supervised client, closing its listener', async () => {
    // The lifecycle bug this guard exists for: a wrapper that `exec`s the
    // client never runs its cleanup, so the relay outlives the session holding
    // its port and (worse) a credential the next session's proxy rejects.
    stub = await startStubProxy()
    relay = startRelay(stub.port, ['sh', '-c', 'exit 7'])
    const relayPort = await relay.port

    const [code] = (await once(relay.child, 'exit')) as [number]
    expect(code).toBe(7)

    // Gone for real: nothing accepts the port any more, so the connection
    // errors instead of opening.
    const probe = connect(relayPort, '127.0.0.1')
    const refused = await readUntil(probe, () => false).then(
      () => false,
      () => true,
    )
    expect(refused).toBe(true)
    probe.destroy()
  }, 30000)

  it('forwards a terminating signal to the supervised client', async () => {
    // The child is `sleep`, which dies on SIGTERM by default. Asserting the
    // relay exited is NOT enough: with no forwarding at all its own SIGTERM
    // handler is absent and it dies anyway, orphaning the client. So the
    // assertion is on the client's pid, which the relay reports on stderr.
    stub = await startStubProxy()
    relay = startRelay(stub.port, ['sleep', '60'])
    await relay.port
    const childPid = await relay.supervisedPid
    expect(alive(childPid)).toBe(true)
    // Nothing of the relay's own may land on stdout: a supervising relay hands
    // that stream to its client, and an MCP client speaks JSON-RPC on it, so
    // one stray line would corrupt the session.
    expect(relay.stdoutText()).toBe('')
    const exited = once(relay.child, 'exit')

    relay.child.kill('SIGTERM')
    await exited

    expect(alive(childPid)).toBe(false)
  }, 30000)

  it('reports the port it actually bound, and rejects a bad argument', () => {
    // The banner carries the bound port, not the requested one, so a caller
    // (or a test) can pass `0` and still find the listener.
    const bad = spawnSync('bun', [RELAY, 'not-a-port'], {
      encoding: 'utf8',
      env: { ...process.env, HTTP_PROXY: 'http://u:p@127.0.0.1:1' },
    })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('usage')
  }, 30000)
})

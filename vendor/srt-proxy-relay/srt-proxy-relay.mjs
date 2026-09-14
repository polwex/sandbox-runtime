#!/usr/bin/env node
/**
 * Local relay for clients that cannot authenticate to srt's proxy.
 *
 * THE GAP
 * Inside a sandbox the proxy requires the per-session credential from
 * `HTTP_PROXY` on every request. Environment-honoring clients (`curl`, `git`,
 * `fetch`) read it automatically, and JVMs are covered by
 * `vendor/java-proxy-agent`. A browser engine is the remaining case:
 * Chromium takes its proxy from a launch flag, ignores credentials embedded
 * in that flag's URL, and `@playwright/mcp` exposes no username/password
 * option — so a browser pointed straight at the proxy gets a 407 on every
 * request (surfacing as a navigation timeout), and with no proxy at all it
 * dials the sandbox's own empty loopback.
 *
 * WHAT IT DOES
 * Accepts a credential-less proxied connection (plain HTTP and CONNECT) and
 * forwards it to the sandbox proxy with the credential attached.
 *
 * It grants no new capability: any process in the sandbox already carries the
 * same token in `HTTP_PROXY`, the listener binds the sandbox's own loopback
 * (so it is unreachable from outside the namespace), and filtering is
 * untouched — the proxy still applies the domain allow/deny lists to every
 * forwarded request.
 *
 * USAGE
 *   srt-proxy-relay [port]                # relay only, default 8899
 *   srt-proxy-relay [port] -- <cmd> [a…]  # relay, then run <cmd> as a
 *                                         # supervised child
 *
 * Point the client at it (`--proxy-server http://127.0.0.1:8899` for
 * playwright-mcp) and do NOT add a bypass list covering `localhost` /
 * `127.0.0.1`: that sends the browser to the sandbox's own loopback instead of
 * the proxy. Keep the session's token fresh by restarting the relay whenever
 * the sandbox is reinitialized — it reads `HTTP_PROXY` once, at startup.
 *
 * The supervised form is the one to use from an MCP config: a single
 * top-level process starts the listener, launches the client, and exits —
 * tearing the listener down — when that client exits or when it is signalled.
 * A shell wrapper (`sh -c 'relay & … exec client'`) cannot do this: `exec`
 * replaces the shell, so an `EXIT` trap never runs and the relay is orphaned
 * holding its port and a soon-to-be-stale credential.
 *
 * Reports (the bound port, and the supervised pid) go to stdout when the relay
 * runs alone — that is how a caller learns the port a `0` argument bound — and
 * to stderr when it supervises a child, whose stdout belongs to the client.
 *
 * Runs under node or bun (node builtins only).
 */
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'

const USAGE = 'usage: srt-proxy-relay.mjs [port] [-- command args…]'

const parent = process.env.HTTP_PROXY ?? process.env.http_proxy
if (!parent) {
  console.error('srt-proxy-relay: HTTP_PROXY is not set (not inside a sandbox?)')
  process.exit(1)
}
const upstream = new URL(parent)
const authorization =
  'Basic ' +
  Buffer.from(
    `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
  ).toString('base64')

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const portArgs = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)
const port = portArgs.length === 0 ? 8899 : Number(portArgs[0])
if (portArgs.length > 1 || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`srt-proxy-relay: ${USAGE}`)
  process.exit(2)
}

const server = http.createServer((req, res) => {
  // Absolute-form request line: the upstream is itself a proxy.
  const forwarded = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'proxy-authorization': authorization },
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  forwarded.on('error', () => res.destroy())
  req.pipe(forwarded)
})

server.on('connect', (req, clientSocket, head) => {
  const upstreamSocket = net.connect(
    Number(upstream.port),
    upstream.hostname,
    () => {
      upstreamSocket.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n` +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      )
    },
  )
  // Give the client nothing until the upstream's own handshake verdict: a 407
  // must reach it as a 407, not as an established tunnel that dies later.
  let handshake = ''
  const onHandshake = chunk => {
    handshake += chunk.toString('latin1')
    if (!handshake.includes('\r\n\r\n')) return
    upstreamSocket.off('data', onHandshake)
    clientSocket.write(handshake)
    if (!/^HTTP\/1\.[01] 200/.test(handshake)) {
      upstreamSocket.destroy()
      clientSocket.destroy()
      return
    }
    // Bytes the client sent after its CONNECT (TLS ClientHello, usually) were
    // read ahead of this handshake and must be flushed upstream.
    if (head?.length) upstreamSocket.write(head)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  }
  upstreamSocket.on('data', onHandshake)
  upstreamSocket.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstreamSocket.destroy())
})

server.listen(port, '127.0.0.1', () => {
  // Report the PORT ACTUALLY BOUND: with `0` the kernel picks, and a caller
  // (or a test) needs the real one.
  const bound = server.address().port
  // A supervised child owns stdout: an MCP client speaks JSON-RPC there, and a
  // single stray line corrupts the stream. So the reports move to stderr as
  // soon as this relay is wrapping a client.
  const report = command.length === 0 ? console.log : console.error
  report(`srt-proxy-relay listening on 127.0.0.1:${bound} -> ${upstream.host}`)
  if (command.length === 0) return

  // Supervised child: the relay is the top-level process, so its exit (for any
  // reason) is what tears the listener down, and a signal delivered here is
  // forwarded rather than orphaning the client.
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
  // Reported so a caller can see (and reap) the supervised process: without
  // it, a relay that dies abnormally leaves a client nobody can name.
  report(`srt-proxy-relay supervising pid=${child.pid}`)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('exit', (code, signal) => {
    server.close()
    // Mirror the child's status so the caller sees the real outcome.
    process.exit(signal ? 128 : (code ?? 0))
  })
  child.on('error', err => {
    console.error(`srt-proxy-relay: cannot start ${command[0]}: ${err.message}`)
    process.exit(127)
  })
})

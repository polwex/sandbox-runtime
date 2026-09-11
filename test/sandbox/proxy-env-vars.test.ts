import { describe, it, expect } from 'bun:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  generateProxyEnvVars,
  CA_TRUST_VARS,
} from '../../src/sandbox/sandbox-utils.js'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'
import { spawnAsync } from '../helpers/spawn.js'
import { isLinux } from '../helpers/platform.js'

describe('generateProxyEnvVars', () => {
  it('sets CLOUDSDK_PROXY_TYPE to http (gcloud rejects "https")', () => {
    // gcloud's proxy/type only accepts http, http_no_tunnel, socks4, socks5.
    // Our local proxy is an HTTP CONNECT proxy regardless of the traffic it
    // tunnels, so the value must be "http" — see issue #151.
    const env = generateProxyEnvVars(3128, 1080)

    expect(env).toContain('CLOUDSDK_PROXY_TYPE=http')
    expect(env).toContain('CLOUDSDK_PROXY_ADDRESS=localhost')
    expect(env).toContain('CLOUDSDK_PROXY_PORT=3128')
    expect(env).not.toContain('CLOUDSDK_PROXY_TYPE=https')
  })

  it('omits CLOUDSDK_PROXY_* when no HTTP proxy port is configured', () => {
    const env = generateProxyEnvVars(undefined, 1080)

    expect(env.some(v => v.startsWith('CLOUDSDK_PROXY_'))).toBe(false)
  })

  describe('GRPC_PROXY', () => {
    const grpcNames = ['GRPC_PROXY', 'grpc_proxy']

    it('advertises the HTTP CONNECT proxy, and never SOCKS alongside it', () => {
      // gRPC C-core rejects socks5h:// ("scheme not supported in proxy URI"),
      // ignores the var, and resolves directly via c-ares — which the sandbox
      // blocks. It must get an http:// URL, and must not also get a socks one:
      // two values for the same var in the child env is a coin flip.
      const env = generateProxyEnvVars(3128, 1080)

      for (const name of grpcNames) {
        expect(env).toContain(`${name}=http://localhost:3128`)
        expect(env.filter(v => v.startsWith(`${name}=`))).toHaveLength(1)
      }
    })

    it('carries proxy credentials in the URL', () => {
      const env = generateProxyEnvVars(3128, 1080, undefined, 'tok')

      for (const name of grpcNames) {
        expect(env).toContain(`${name}=http://srt:tok@localhost:3128`)
      }
    })

    it('is emitted when only an HTTP proxy port is configured', () => {
      // The value does not depend on the SOCKS port, and a gRPC client in an
      // HTTP-only sandbox needs it just as much.
      const env = generateProxyEnvVars(3128, undefined)

      for (const name of grpcNames) {
        expect(env).toContain(`${name}=http://localhost:3128`)
      }
    })

    it('falls back to SOCKS when no HTTP proxy port is configured', () => {
      const env = generateProxyEnvVars(undefined, 1080)

      for (const name of grpcNames) {
        expect(env).toContain(`${name}=socks5h://localhost:1080`)
      }
    })
  })

  describe('caCertPath', () => {
    it('sets all trust env vars to the CA path when provided', () => {
      const env = generateProxyEnvVars(3128, 1080, '/etc/srt/ca.crt')
      for (const v of CA_TRUST_VARS) {
        expect(env).toContain(`${v}=/etc/srt/ca.crt`)
      }
    })

    it('sets trust env vars even when no proxy ports are configured', () => {
      // tlsTerminate implies network restriction in practice, but the env-var
      // helper should not couple the two.
      const env = generateProxyEnvVars(undefined, undefined, '/etc/srt/ca.crt')
      for (const v of CA_TRUST_VARS) {
        expect(env).toContain(`${v}=/etc/srt/ca.crt`)
      }
    })

    it('omits trust env vars when caCertPath is not provided', () => {
      const env = generateProxyEnvVars(3128, 1080)
      for (const v of CA_TRUST_VARS) {
        expect(env.some(e => e.startsWith(`${v}=`))).toBe(false)
      }
    })
  })

  describe('NO_PROXY', () => {
    it('does not exclude .local hostnames from the proxy', () => {
      // Under network restriction the child has no usable resolver, so a
      // NO_PROXY match on *.local makes clients attempt direct getaddrinfo()
      // and fail before any request is sent. .local must go through the
      // proxy so the parent resolves it (e.g. k8s *.svc.cluster.local).
      const env = generateProxyEnvVars(3128, 1080)
      for (const name of ['NO_PROXY', 'no_proxy']) {
        const entry = env.find(e => e.startsWith(`${name}=`))
        expect(entry).toBeDefined()
        const tokens = entry!.slice(name.length + 1).split(',')
        expect(tokens).not.toContain('.local')
        expect(tokens).not.toContain('*.local')
      }
    })

    it('omits the loopback entries when loopback is routed via the proxy', () => {
      // bwrap --unshare-net gives the child its own loopback, so a NO_PROXY
      // match on 127.0.0.1 makes the client dial a namespace with nothing in
      // it. The Linux wrapper sets this when the policy allow-lists loopback.
      const env = generateProxyEnvVars(
        3128,
        1080,
        undefined,
        undefined,
        false,
        undefined,
        {
          routeLoopbackViaProxy: true,
        },
      )
      const entry = env.find(e => e.startsWith('NO_PROXY='))!
      const tokens = entry.slice('NO_PROXY='.length).split(',')
      for (const loopback of ['localhost', '127.0.0.1', '::1']) {
        expect(tokens).not.toContain(loopback)
      }
      // Private ranges still bypass the proxy — only loopback moved.
      expect(tokens).toContain('10.0.0.0/8')
    })

    it('keeps the loopback entries by default (macOS shares the host stack)', () => {
      const env = generateProxyEnvVars(3128, 1080)
      const entry = env.find(e => e.startsWith('NO_PROXY='))!
      const tokens = entry.slice('NO_PROXY='.length).split(',')
      expect(tokens).toContain('localhost')
      expect(tokens).toContain('127.0.0.1')
      expect(tokens).toContain('::1')
    })

    it.if(isLinux)(
      'sandboxed curl reaches a host-loopback server named in allowedDomains',
      async () => {
        // The reported failure: a dev server runs on the host's loopback (the
        // sandboxed process cannot be the listener — #165), the policy
        // allow-lists it, and the request dies because the child dials its
        // own empty loopback namespace. Both spellings must work, and the
        // allowlist entry may name either one.
        let origin: Server | undefined
        const hits: string[] = []
        try {
          origin = createServer((req, res) => {
            hits.push(req.url ?? '')
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('host-loopback-origin')
          })
          const originPort = await new Promise<number>((resolve, reject) => {
            origin!.on('error', reject)
            origin!.listen(0, '127.0.0.1', () =>
              resolve((origin!.address() as AddressInfo).port),
            )
          })

          await SandboxManager.initialize({
            network: { allowedDomains: ['localhost'], deniedDomains: [] },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          })

          for (const host of ['localhost', '127.0.0.1']) {
            const wrapped = await SandboxManager.wrapWithSandbox(
              `curl -s --max-time 5 http://${host}:${originPort}/probe-${host}`,
            )
            const result = await spawnAsync(wrapped, {
              shell: true,
              encoding: 'utf8',
              timeout: 10000,
            })
            expect(result.stdout).toContain('host-loopback-origin')
            expect(result.status).toBe(0)
          }
          expect(hits).toEqual(['/probe-localhost', '/probe-127.0.0.1'])
        } finally {
          await SandboxManager.reset()
          if (origin) await new Promise<void>(r => origin!.close(() => r()))
        }
      },
    )

    it.if(isLinux)(
      'sandboxed curl to loopback still fails when the policy does not allow it',
      async () => {
        // The fix must not turn loopback into an implicit allow: an empty
        // allowlist leaves loopback blocked like any other destination.
        let origin: Server | undefined
        const hits: string[] = []
        try {
          origin = createServer((_req, res) => {
            hits.push('hit')
            res.writeHead(200)
            res.end('should-not-be-reached')
          })
          const originPort = await new Promise<number>((resolve, reject) => {
            origin!.on('error', reject)
            origin!.listen(0, '127.0.0.1', () =>
              resolve((origin!.address() as AddressInfo).port),
            )
          })

          await SandboxManager.initialize({
            network: { allowedDomains: [], deniedDomains: [] },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          })

          const wrapped = await SandboxManager.wrapWithSandbox(
            `curl -s --max-time 5 http://localhost:${originPort}/`,
          )
          await spawnAsync(wrapped, {
            shell: true,
            encoding: 'utf8',
            timeout: 10000,
          })
          expect(hits).toEqual([])
        } finally {
          await SandboxManager.reset()
          if (origin) await new Promise<void>(r => origin!.close(() => r()))
        }
      },
    )

    it.if(isLinux)(
      'sandboxed curl to a .local hostname reaches the parent proxy',
      async () => {
        let proxy: Server | undefined
        const received: string[] = []
        try {
          proxy = createServer((req, res) => {
            received.push(req.url ?? '')
            res.writeHead(200)
            res.end('ok')
          })
          proxy.on('connect', (req, sock) => {
            received.push(req.url ?? '')
            sock.end('HTTP/1.1 200 OK\r\n\r\n')
          })
          const proxyPort = await new Promise<number>((resolve, reject) => {
            proxy!.on('error', reject)
            proxy!.listen(0, '127.0.0.1', () =>
              resolve((proxy!.address() as AddressInfo).port),
            )
          })

          const config: SandboxRuntimeConfig = {
            network: {
              allowedDomains: ['srt-test.local'],
              deniedDomains: [],
              httpProxyPort: proxyPort,
            },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          }
          await SandboxManager.initialize(config)
          expect(SandboxManager.getProxyPort()).toBe(proxyPort)

          const wrapped = await SandboxManager.wrapWithSandbox(
            'curl -s --max-time 5 http://srt-test.local:8080/',
          )
          const result = await spawnAsync(wrapped, {
            shell: true,
            encoding: 'utf8',
            timeout: 10000,
          })

          expect(result.status).toBe(0)
          // Plain HTTP via proxy → absolute-form request line.
          expect(received).toContain('http://srt-test.local:8080/')
        } finally {
          await SandboxManager.reset()
          if (proxy) {
            await new Promise<void>(r => proxy!.close(() => r()))
          }
        }
      },
    )
  })
})

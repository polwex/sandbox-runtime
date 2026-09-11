#!/bin/sh
#
# In-sandbox HTTP proxy front end with loopback-first routing.
#
# WHY THIS EXISTS
# On Linux the sandbox runs under `bwrap --unshare-net`, so the sandboxed
# process has its own network namespace: "localhost" inside the sandbox is a
# different loopback from the host's. That makes both directions of a dev
# workflow fail for opposite reasons:
#
#   * a dev server started OUTSIDE the sandbox (the user's terminal, a
#     `tailscale serve`, another tool) listens on the HOST's 127.0.0.1, which
#     a direct connect inside the sandbox cannot reach at all;
#   * a dev server the sandboxed process itself starts listens on the
#     SANDBOX's 127.0.0.1, which the host proxy cannot reach.
#
# Only the proxy crosses the namespace boundary, so a loopback destination is
# reachable in exactly one of the two ways per request. This shim therefore
# asks the sandbox's own loopback first (cheap, in-namespace) and falls back
# to the host proxy when nothing is listening there. Both workflows work.
#
# POLICY
# Local-first is used ONLY for a loopback destination (`localhost`, `*.localhost`,
# `127.0.0.0/8`, `::1`) named by a CONNECT authority or an absolute-form
# request-URI. Nothing else is dialled locally, so a non-loopback destination
# always reaches the parent proxy and the allow/deny lists still decide it.
# The local dial is a loopback address the sandbox could already reach on its
# own before this shim existed; it grants no egress.
#
# INTERFACE
# Run once per connection by socat, with the client's bytes on stdin and the
# response expected on stdout:
#
#   SRT_SHIM_SELF_PORT=3128 SRT_SHIM_PARENT_SOCK=/tmp/srt-http-*.sock \
#     socat TCP-LISTEN:3128,fork,reuseaddr EXEC:'bash /path/to/shim.sh'
#
# SRT_SHIM_SELF_PORT is this listener's own port, so a request for it is never
# dialled locally (that would recurse through this very script).
# SRT_SHIM_PARENT_SOCK is the parent proxy's Unix socket inside the sandbox.

parent=${SRT_SHIM_PARENT_SOCK:?SRT_SHIM_PARENT_SOCK is not set}
self=${SRT_SHIM_SELF_PORT:-}
CR=$(printf '\r')
NL='
'

# `read -n` is a bash/zsh extension used to classify the stream's first byte
# before reading a line. Without it the shim still routes HTTP correctly via
# the line-based path; it only loses the early classification of a stream
# that is not HTTP (which then waits for a newline like the plain bridge did).
case ${BASH_VERSION:-}${ZSH_VERSION:-} in
  '') READ_ONE_BYTE='' ;;
  *) READ_ONE_BYTE=1 ;;
esac

# Read the request head.
#
# An HTTP request always begins with an uppercase method (GET, POST, CONNECT,
# …). Anything else — a SOCKS greeting (0x05), a TLS record (0x16), SSH — is
# not ours to route and must NOT be read as a line: it will never contain the
# newline this loop waits for, so the client would hang until it timed out.
# Such a stream is forwarded immediately, and because only the first byte has
# been consumed it keeps every byte after it, NULs included.
#
# For HTTP, `read` consumes exactly through the newline — on a socket the
# kernel gives it one byte at a time — so any body that follows stays queued
# for the relay below and is forwarded byte-for-byte. The CRLF is re-emitted
# only where it was consumed: a stream that ends without one (a client that
# sent no headers and closed) goes out exactly as it arrived.
head=''
if [ -n "$READ_ONE_BYTE" ]; then
  IFS= read -r -n 1 b1
  case $b1 in
    [A-Z]) ;;
    *)
      { printf '%s' "$b1"; cat; } | socat - UNIX-CONNECT:"$parent"
      exit $?
      ;;
  esac
  head=$b1
fi
while :; do
  if IFS= read -r line; then
    line=${line%"$CR"}
    head=$head$line$CR$NL
    [ -z "$line" ] && break
  else
    # EOF with a partial line: no delimiter was consumed, so add none.
    head=$head$line
    break
  fi
  # A head beyond this is not something to parse a target out of; the relay
  # still forwards every byte, so only the local-first attempt is given up.
  [ ${#head} -gt 16384 ] && break
done

# The request line is the first line of what was read — the byte consumed
# above is its first character.
first=${head%%"$CR$NL"*}
first=${first%%"$NL"*}

# A proxied request names its destination as `CONNECT host:port` or as an
# absolute URI (`GET http://host:port/path HTTP/1.1`). Any other shape (an
# origin-form request, a non-HTTP stream) is not ours to route: it goes to the
# parent, exactly as it did before this shim existed.
target=''
case $first in
  CONNECT\ *)
    target=${first#CONNECT }
    target=${target%% *}
    ;;
  *://*)
    target=${first#*://}
    target=${target%% *}
    target=${target%%/*}
    target=${target##*@}
    ;;
esac

port=''
if [ -n "$target" ]; then
  host=${target%:*}
  port=${target##*:}
  # No explicit port: HTTP's default. It still gets the local-first attempt,
  # which is what a `http://localhost/` request needs.
  [ "$port" = "$target" ] && port=80
  case $host in
    localhost | 127.* | '[::1]' | ::1 | *.localhost) ;;
    *) port='' ;;
  esac
  [ -n "$self" ] && [ "$port" = "$self" ] && port=''
fi

if [ -n "$port" ]; then
  # Probe without sending anything. A failed probe must not have consumed the
  # client's body — that is why the connect is tested separately from the
  # relay instead of letting a dead read end swallow the request.
  if socat -T 1 -u /dev/null "TCP:127.0.0.1:$port" >/dev/null 2>&1; then
    case $first in
      CONNECT\ *)
        # The client asked for a tunnel to loopback and a server answers
        # there, so complete the tunnel here: answer the CONNECT and relay
        # the bytes that follow opaquely. Forwarding the CONNECT itself would
        # hand it to the server as if it spoke proxy protocol — a local HTTPS
        # server would see it instead of a TLS ClientHello.
        printf 'HTTP/1.1 200 Connection Established\r\n\r\n'
        socat - "TCP:127.0.0.1:$port"
        exit $?
        ;;
      *)
        { printf '%s' "$head"; cat; } | socat - "TCP:127.0.0.1:$port"
        exit $?
        ;;
    esac
  fi
fi

{ printf '%s' "$head"; cat; } | socat - UNIX-CONNECT:"$parent"

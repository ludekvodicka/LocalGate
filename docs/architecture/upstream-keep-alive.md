# Upstream keep-alive

## Decision

The proxy reaches a dev server through its own `http.Agent` that keeps sockets alive for at most 1 s
between requests. Only a `GET`, `HEAD` or `OPTIONS` request without a body takes such a socket. When
the dev server resets a reused socket before it answers, the proxy sends that request once more on a
fresh connection, and only the result of that second attempt can move the route to `starting` or
`dead`. Every other request opens its own connection and is never sent twice.

## The failure it fixes

A Node server, Next.js included, closes a kept-alive socket 5 s after its last response. The proxy
used the global agent, which reuses a free socket until 1 s before the `Keep-Alive: timeout=5` hint.
That margin holds only while the dev server's event loop runs. When the loop is blocked, by a debugger
attached to every child process or by a long compile, the idle timer runs late: the server reads no
request from a socket that already holds one, then closes that socket. The proxy saw `ECONNRESET`,
read it as a dev server that had not bound its port yet, and answered
`localgate: <name> is still starting. Reload in a moment.`.

Measured against a Next 16.4.3 dev server with the VSCode debugger attached: requests on reused
sockets with 3.5-5.5 s gaps got `ECONNRESET` 7-11 s after they were sent, in 2 of 7 attempts. 15 of
15 requests on fresh connections in the same period were answered. Through the proxy, 2 of 12
requests got the "still starting" page before the change and 0 of 20 after it.

## Why both halves

- **Fresh connections only** would remove the race, but a page load sends dozens of requests, and
  Windows keeps every closed loopback connection in `TIME_WAIT` for two minutes.
- **The retry only** cannot cover a request with a body: the body is streamed through once and is
  gone by the time of the reset. A method that changes state must not run twice either, because the
  first attempt may have reached the server.
- **The 1 s idle limit** makes the reset rare. The retry handles the case the limit cannot exclude,
  a request that arrives at a dev server whose loop is blocked.

The agent `timeout` is the idle limit of a free socket. A request in progress uses the proxy's own
30 s first-byte timeout instead, so a response slower than 1 s is still awaited; a test covers that
on a fresh and on a reused socket.

## Key files

- `logic/proxy/localgateProxy.ts`: `forward` chooses the connection, `dial` sends and retries
- `logic/proxy/localgateProxy.test.ts`: retry on a reset reused socket, body requests on their own
  connections, slow responses over the idle limit

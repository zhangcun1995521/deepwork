/**
 * Evaluate an expression inside a running Chrome, over the DevTools protocol.
 *
 * Why this exists: verifying a DSH UI surface needs a real browser, and the obvious
 * tool — `chrome --headless --dump-dom` — does not work here. `--dump-dom` waits for
 * the page to go idle, and the DSH web client holds an open WebSocket for its event
 * stream, so it never does. The command hangs until it is killed and prints nothing,
 * which looks exactly like a broken page.
 *
 * So we drive the browser directly instead: start Chrome with `--remote-debugging-port`,
 * attach over the protocol, and ask the page what it sees.
 *
 *   node scripts/cdp-probe.mjs <port> "<expression>"
 *
 * Node's global `WebSocket` (Node 22+) means no dependency for this. The expression runs
 * with `awaitPromise` and `returnByValue`, so it can be `await fetch(...)` and the result
 * comes back as JSON rather than as a remote-object handle.
 *
 * @module scripts/cdp-probe
 */

const port = process.argv[2] ?? '9222'
const expression = process.argv[3] ?? 'document.body.innerText'

/** Ask Chrome which pages it currently has open. */
async function findPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP list failed: ${response.status}`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (page === undefined) throw new Error('no page target is open')
  return page
}

/** Evaluate one expression in that page and return its value. */
async function evaluate(page, source) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 30_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      })
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: source, returnByValue: true, awaitPromise: true },
        }),
      )
    })
  } finally {
    socket.close()
  }
}

try {
  const page = await findPage()
  const result = await evaluate(page, expression)
  const value = result?.result?.value
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`cdp-probe: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

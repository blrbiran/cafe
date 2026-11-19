import { expect, test } from 'claude-code/testing'

// The session-host child is faked: its stdout is fed line by line from `feed`, and the control-socket
// POSTs are captured from `http.fetch`. Nothing here starts a process or reaches the network.

type Post = { path: string; body: Record<string, unknown> }

function fakeHost(on: any) {
  const lines: string[] = []
  let wake: (() => void) | undefined
  let closed = false
  const posts: Post[] = []
  const submits: string[] = []
  const aborts: string[] = []
  const spawned: string[][] = []

  on('fs.read', () => ({ value: JSON.stringify({ argv: ['node', '/opt/cafe/bin/cafe.js'] }) }))
  on('command.register', () => ({ value: { command: 'cafe' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    spawned.push([...e.argv])
    while (!closed) {
      while (lines.length) yield { stream: 'stdout', text: lines.shift()! + '\n' }
      if (closed) break
      await new Promise<void>(r => (wake = r))
    }
    return { code: 0, signal: null }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', (_: unknown, e: { url: string; init: { body: string; socketPath?: string } }) => {
    expect(e.init.socketPath).toBe('/tmp/s.sock')
    posts.push({ path: new URL(e.url).pathname, body: JSON.parse(e.init.body) })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true }) } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    submits.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', (_: unknown, e: { turnId: string }) => {
    aborts.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', (_: unknown, e: unknown) => e)
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))

  const feed = async (msg: Record<string, unknown>) => {
    lines.push(JSON.stringify(msg))
    wake?.()
    await new Promise(r => setTimeout(r, 20))
  }
  const close = () => {
    closed = true
    wake?.()
  }
  return { feed, close, posts, submits, aborts, spawned }
}

const settle = () => new Promise(r => setTimeout(r, 20))
const turnEnd = (turnId: string, answer: string, isAborted = false) =>
  ({ turnId, answer, isAborted, reason: isAborted ? 'aborted' : 'answer', durationMs: 5 }) as const

test('an Order becomes a turn of its own; the turn\'s final text goes back as the answer', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/work/falcon', surface: 'terminal', isInteractive: true } as any)
  await settle()
  expect(host.spawned[0]).toEqual(['node', '/opt/cafe/bin/cafe.js', 'session-host', '--agent', 'claude', '--dir', '/work/falcon'])

  await host.feed({ type: 'ready', address: 'falcon#1@mac', socket: '/tmp/s.sock' })
  await host.feed({ type: 'order', orderId: 'O1', marker: '[cafe order O1]', text: '[cafe order O1]\nWhat port?' })
  expect(host.submits).toEqual(['[cafe order O1]\nWhat port?'])

  // A turn the person starts is not the Order's.
  await $.turn.start({ text: 'my own question', turnId: 'human' } as any)
  await $.turn.complete(turnEnd('human', 'not for cafe') as any)
  expect(host.posts).toEqual([])

  await $.turn.start({ text: '[cafe order O1]\nWhat port?', turnId: 't1' } as any)
  await settle()
  await $.turn.complete(turnEnd('t1', '9123') as any)
  await settle()
  expect(host.posts).toEqual([
    { path: '/started', body: { orderId: 'O1' } },
    { path: '/done', body: { orderId: 'O1', text: '9123', aborted: false } },
  ])
  host.close()
})

test('a cancel aborts the running turn, or the Order\'s turn as soon as it starts', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await settle()
  await host.feed({ type: 'ready', address: 'w#1@mac', socket: '/tmp/s.sock' })

  await host.feed({ type: 'order', orderId: 'A', marker: '[cafe order A]', text: '[cafe order A]\nlong job' })
  await $.turn.start({ text: '[cafe order A]\nlong job', turnId: 'tA' } as any)
  await settle()
  await host.feed({ type: 'cancel', orderId: 'A' })
  expect(host.aborts).toEqual(['tA'])
  await $.turn.complete(turnEnd('tA', 'partial', true) as any)
  await settle()

  // Cancelled before its turn started: aborted on start.
  await host.feed({ type: 'order', orderId: 'B', marker: '[cafe order B]', text: '[cafe order B]\nnext' })
  await host.feed({ type: 'cancel', orderId: 'B' })
  await $.turn.start({ text: '[cafe order B]\nnext', turnId: 'tB' } as any)
  await settle()
  expect(host.aborts).toEqual(['tA', 'tB'])
  host.close()
})

test('a non-interactive run (claude -p, SDK) never joins the network', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false } as any)
  await settle()
  expect(host.spawned).toEqual([])
})

test('/cafe off and /cafe on pause and resume taking questions', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await settle()
  await host.feed({ type: 'ready', address: 'w#1@mac', socket: '/tmp/s.sock' })
  const off = await $.command.run({ command: 'cafe', args: 'off' } as any)
  expect(JSON.stringify(off)).toContain('stopped taking questions')
  const on2 = await $.command.run({ command: 'cafe', args: 'on' } as any)
  expect(JSON.stringify(on2)).toContain('taking questions again')
  expect(host.posts.map(p => [p.path, p.body.paused])).toEqual([
    ['/pause', true],
    ['/pause', false],
  ])
  host.close()
})

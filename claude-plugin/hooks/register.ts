import type { EngineInterface, Register } from 'claude-code'

// cafe: this interactive Claude Code session answers questions (Orders) routed to it on the cafe network
// (docs/specs/v3-1-native-codex-claude.md, phase 2). `cafe session-host` (a child of the session) holds the
// network connection; it hands Orders over one at a time as JSON lines and takes the answers back over its
// control socket. Each Order becomes a turn of its own once the session is idle; the turn's final text is
// the reply. Tool approvals stay with the person at the terminal.

type HostMessage =
  | { type: 'none'; reason: string }
  | { type: 'ready'; address: string; socket: string }
  | { type: 'status'; address?: string; paused: boolean }
  | { type: 'order'; orderId: string; marker: string; text: string }
  | { type: 'cancel'; orderId: string }

type Current = { orderId: string; marker: string; turnId?: string; cancelled: boolean }

// Module state: a reload starts over and spawns a new session-host (the old child dies with the old module).
let socket: string | undefined
let address: string | undefined
let paused = false
let current: Current | undefined

const status = ($: EngineInterface) =>
  $.ui.status(address ? (paused ? `☕ ${address} (paused)` : `☕ ${address}`) : undefined)

async function post($: EngineInterface, path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (!socket) return undefined
  try {
    const res = await $.http.fetch(`http://localhost${path}`, {
      method: 'POST',
      socketPath: socket,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return JSON.parse(res.text) as Record<string, unknown>
  } catch (err) {
    $.ui.log(`cafe: ${path} failed: ${(err as Error).message}`, { to: 'debug' })
    return undefined
  }
}

async function submit($: EngineInterface, order: Current, text: string) {
  const r = await $.prompt.submit({ text }).catch((err: Error) => ({ drop: err.message }))
  if ('drop' in r && r.drop !== undefined && current?.orderId === order.orderId) {
    current = undefined
    await post($, '/done', { orderId: order.orderId, error: r.drop })
  }
}

async function handle($: EngineInterface, msg: HostMessage) {
  if (msg.type === 'none') return
  if (msg.type === 'ready') {
    socket = msg.socket
    address = msg.address
  } else if (msg.type === 'status') {
    if (msg.address) address = msg.address
    paused = msg.paused
  } else if (msg.type === 'order') {
    current = { orderId: msg.orderId, marker: msg.marker, cancelled: false }
    void submit($, current, msg.text)
  } else if (msg.type === 'cancel') {
    if (current?.orderId !== msg.orderId) return
    current.cancelled = true
    if (current.turnId) await $.turn.abort({ turnId: current.turnId }).catch(() => {})
  }
  status($)
}

async function host($: EngineInterface, cwd: string) {
  let argv = ['cafe']
  try {
    const conf = JSON.parse(await $.fs.read(`${$.plugin.root}/cafe.json`)) as { argv?: string[] }
    if (Array.isArray(conf.argv) && conf.argv.length) argv = conf.argv
  } catch {
    // no cafe.json: use `cafe` from PATH
  }
  const child = $.process.spawn({ argv: [...argv, 'session-host', '--agent', 'claude', '--dir', cwd] })
  let buf = ''
  try {
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      buf += chunk.text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        try {
          await handle($, JSON.parse(line) as HostMessage)
        } catch (err) {
          $.ui.log(`cafe: ${(err as Error).message}`, { to: 'debug' })
        }
      }
    }
  } catch (err) {
    $.ui.log(`cafe: cannot start cafe session-host: ${(err as Error).message}`, { to: 'debug' })
  }
  socket = undefined
  address = undefined
  current = undefined
  status($)
}

/**
 * Barista session control. `/cafe` belongs to the Customer side (installed as a
 * Claude Code command by `cafe commands install`, same subcommands as pi/omp);
 * the plugin's pause/resume lives on `/cafe-barista` in every session.
 */
const COMMANDS = ['cafe-barista'] as const
let commandName: string | undefined

async function registerCommand($: EngineInterface) {
  for (const name of COMMANDS) {
    try {
      await $.command.register({
        name,
        description: 'cafe session: show this session\'s address, or stop / resume answering questions',
        argumentHint: '[on|off]',
      })
      commandName = name
      return
    } catch (err) {
      $.ui.log(`cafe: /${name} is not available: ${(err as Error).message}`, { to: 'debug' })
    }
  }
  $.ui.log('cafe: no session slash command registered; the cafe tools and status still work', { to: 'debug' })
}

async function cafeCommand($: EngineInterface, e: { args: string }) {
  try {
    const arg = e.args.trim()
    if (!socket) return { text: 'This directory has no .cafe Barista identity, or the cafe session-host is not running.' }
    if (arg === 'off' || arg === 'on') {
      const r = await post($, '/pause', { paused: arg === 'off' })
      if (r?.ok) paused = arg === 'off'
      status($)
      return { text: paused ? `${address} stopped taking questions (/${commandName ?? 'cafe'} on to resume).` : `${address} is taking questions again.` }
    }
    return { text: `This session answers as ${address}${paused ? ' (paused)' : ''}. /${commandName ?? 'cafe'} off stops taking questions, /${commandName ?? 'cafe'} on resumes.` }
  } catch (err) {
    // A command handler must not reject: the person gets the message instead.
    return { text: `cafe: ${(err as Error).message}` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Only a session someone is using in a terminal; `-p` runs and SDK hosts stay out of the network.
    if (!e.isInteractive) return started
    // Registration is best effort: a refused command must not abort the session or the Barista.
    await registerCommand($).catch((err) => $.ui.log(`cafe: command registration failed: ${(err as Error).message}`, { to: 'debug' }))
    void host($, e.cwd)
    return started
  })

  on('command.run', { command: 'cafe-barista' }, cafeCommand)

  // The turn that starts with our Order's marker is the Order's turn.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined && current && !current.turnId && e.text.includes(current.marker)) {
      current.turnId = e.turnId
      const order = current
      void (async () => {
        await post($, '/started', { orderId: order.orderId })
        if (order.cancelled) await $.turn.abort({ turnId: e.turnId }).catch(() => {})
      })()
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && current?.turnId === e.turnId) {
      const order = current
      current = undefined
      const error = e.reason === 'error' || e.reason === 'refusal' ? e.reason : undefined
      void post($, '/done', { orderId: order.orderId, text: e.answer, aborted: e.isAborted, error })
    }
    return next(e)
  })
}

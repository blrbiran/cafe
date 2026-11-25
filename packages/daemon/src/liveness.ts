import type { WebSocket } from "ws";

/**
 * Transport-level liveness for a Daemon link (#99). A TCP connection whose peer process died can stay
 * `ESTABLISHED` forever (no FIN/RST reaches us), so the `close` event that every reconnect path hangs
 * off never fires. WebSocket ping/pong proves the peer is still there at the protocol layer: it creates
 * no Thread events and costs one tiny frame per interval.
 *
 * Starts only once the socket is OPEN: `ws.ping()` throws while CONNECTING, and a dial that is still
 * resolving (a black-holed SYN, slow TLS discovery) must not be mistaken for a dead peer. With
 * `intervalMs = I` and `misses = 2`: ping at t=0, a missing pong at t=I counts as miss 1 (and pings
 * again), a second miss at t=2I calls `onDead`. Any inbound frame counts as proof of life, so a busy
 * socket whose pongs queue behind data is not killed by mistake.
 */
export function watchLiveness(ws: WebSocket, opts: { intervalMs: number; misses?: number; onDead: () => void; onAlive?: () => void }): () => void {
  const misses = Math.max(1, opts.misses ?? 2);
  let missed = 0;
  let answered = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const markAlive = () => {
    answered = true;
    missed = 0;
    opts.onAlive?.();
  };
  const tick = () => {
    if (stopped) return;
    if (answered) {
      missed = 0;
    } else {
      missed += 1;
      if (missed >= misses) {
        stop();
        opts.onDead();
        return;
      }
    }
    answered = false;
    try {
      ws.ping();
    } catch {
      stop();
      opts.onDead();
    }
  };
  const start = () => {
    if (stopped || timer) return;
    timer = setInterval(tick, opts.intervalMs);
    timer.unref?.();
    tick();
  };
  const onPong = () => markAlive();
  const onMessage = () => markAlive();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    ws.off?.("pong", onPong);
    ws.off?.("message", onMessage);
    ws.off?.("open", start);
    ws.off?.("close", stop);
  };
  ws.on("pong", onPong);
  ws.on("message", onMessage);
  ws.on("open", start);
  ws.on("close", stop);
  // A socket handed over already open (tests, server-side accepts) starts now.
  if (ws.readyState === ws.OPEN) start();
  return stop;
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runBridge } from "../packages/cli/src/bridge/barista.ts";
import { customer, startDaemon, untilClosed, waitFor } from "./helpers.ts";

// A running Codex session (the TUI) as a Barista: questions go into the session's queue; the test plays the TUI.
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-codex-tui.mjs");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type Item = { id: string; clientUserMessageId: string; text: string };

async function setup(opts: { thread?: string; injectTimeoutMs?: number; threads?: (dir: string) => object[]; beforeBridge?: (state: string) => void } = {}) {
  const root = await startDaemon("root", { mode: "root" });
  cleanup.push(root.stop);
  const tmp = mkdtempSync(join(tmpdir(), "cafe-codex-tui-"));
  cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  const dir = join(tmp, "work");
  const state = join(tmp, "state");
  mkdirSync(dir);
  mkdirSync(state);
  writeFileSync(join(dir, ".cafe"), "name: coder\ndescription: answers questions about the code\n");
  // One idle session in the directory unless a test asks for more: the Barista never guesses when
  // several are open (#100).
  const threads = opts.threads?.(dir) ?? [
    { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
    { id: "side", cwd: dir, updatedAt: 400, ephemeral: true },
    { id: "elsewhere", cwd: tmp, updatedAt: 500, ephemeral: false },
  ];
  writeFileSync(join(state, "threads.json"), JSON.stringify(threads));
  opts.beforeBridge?.(state);
  process.env.FAKE_CODEX_STATE = state;
  process.env.FAKE_CODEX_LOG = join(tmp, "codex.log");
  cleanup.push(() => {
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_LOG;
  });
  const logs: string[] = [];
  const b = await runBridge({
    agent: "codex",
    tui: true,
    thread: opts.thread,
    dir,
    daemon: root.addr,
    bin: FAKE,
    tuiTiming: { pollMs: 25, injectTimeoutMs: opts.injectTimeoutMs ?? 5000 },
    log: process.env.BRIDGE_DEBUG ? (m) => console.log("BRIDGE", m) : (m) => logs.push(m),
  });
  cleanup.push(b.stop);
  const c = await customer(root.addr);
  cleanup.push(() => c.close());

  const file = (name: string) => join(state, name);
  // Atomic, so the fake never reads a half-written file.
  const put = (name: string, v: unknown) => {
    writeFileSync(file(`${name}.tmp`), JSON.stringify(v));
    renameSync(file(`${name}.tmp`), file(name));
  };
  const readJson = <T>(name: string, fallback: T): T => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fallback);
  /** The TUI side. */
  const tui = {
    queue: (thread = "live") => readJson<Item[]>(`queue-${thread}.json`, []),
    /** Take the next queued item (the session became idle). */
    take: (thread = "live") => {
      const [first, ...rest] = tui.queue(thread);
      put(`queue-${thread}.json`, rest);
      return first!;
    },
    /** Write the turn for a taken item as another process sees it. */
    turn: (item: Item, t: { status: string; answer?: string; completedAt?: number | null }, thread = "live") => {
      const turns = readJson<object[]>(`turns-${thread}.json`, []).filter((x: any) => x.id !== `turn-${item.id}`);
      const items: object[] = [{ type: "userMessage", clientId: item.clientUserMessageId, content: [{ type: "text", text: item.text }] }];
      if (t.answer) items.push({ type: "agentMessage", text: "looking…", phase: "commentary" }, { type: "agentMessage", text: t.answer, phase: "final_answer" });
      put(`turns-${thread}.json`, [{ id: `turn-${item.id}`, status: t.status, completedAt: t.completedAt ?? null, items }, ...turns]);
    },
  };
  const ask = async (body: string, threadId?: string) => c.ask({ body, to: "coder", threadId });
  return { root, dir, tui, c, ask, logs };
}

const replyOf = (events: { event: { type: string } }[]) => (events.find((e) => e.event.type === "order.replied")?.event as { text: string } | undefined)?.text;
const declineOf = (events: { event: { type: string } }[]) => events.find((e) => e.event.type === "order.declined")?.event as { reason: string; unavailable?: boolean } | undefined;

describe("Codex TUI Barista (barista run --agent codex --tui)", () => {
  it("uses the only session in its directory, says which one, and answers with the turn's final message", async () => {
    const { root, tui, c, ask, logs } = await setup();
    expect(root.daemon.registry.all().find((r) => r.name === "coder")).toMatchObject({ mode: "tui", agent: "codex" });
    expect(root.daemon.registry.all().find((r) => r.name === "coder")?.access).toBeUndefined();
    // The person must be able to tell which Codex session is being used (#100).
    expect(logs.join("\n")).toContain("live");

    const a = await ask("what is x");
    await waitFor(() => tui.queue().length === 1);
    expect(tui.queue("side")).toEqual([]);
    const item = tui.take();
    expect(item.text).toContain("Question:\nwhat is x");
    const done = untilClosed(c, a.threadId, a.orderId);
    // Still running in the TUI: another process reads it as interrupted without completedAt.
    tui.turn(item, { status: "interrupted" });
    await new Promise((r) => setTimeout(r, 150));
    tui.turn(item, { status: "completed", answer: "x is 42", completedAt: 1 });
    expect(replyOf(await done)).toBe("x is 42");

    // A follow-up in the same cafe Thread goes to the same session without the history.
    const f = await ask("and y?", a.threadId);
    await waitFor(() => tui.queue().length === 1);
    const fItem = tui.take();
    expect(fItem.text.startsWith("Follow-up from")).toBe(true);
    const fDone = untilClosed(c, f.threadId, f.orderId);
    tui.turn(fItem, { status: "completed", answer: "y is 7", completedAt: 2 });
    expect(replyOf(await fDone)).toBe("y is 7");
  });

  it("a question the session does not pick up in time is withdrawn and declined as unavailable", async () => {
    const { tui, c, ask } = await setup({ injectTimeoutMs: 200 });
    const a = await ask("anyone?");
    const events = await untilClosed(c, a.threadId, a.orderId);
    expect(declineOf(events)).toMatchObject({ unavailable: true });
    expect(declineOf(events)?.reason).toContain("did not take the question");
    expect(tui.queue()).toEqual([]);
  });

  it("cancel withdraws a queued question; a started one is dropped and the next question goes on", async () => {
    const { tui, c, ask } = await setup();
    const a = await ask("first");
    await waitFor(() => tui.queue().length === 1);
    await c.cancel(a.threadId);
    await waitFor(() => tui.queue().length === 0);

    const b = await ask("second");
    await waitFor(() => tui.queue().length === 1);
    const bItem = tui.take();
    tui.turn(bItem, { status: "interrupted" });
    await c.cancel(b.threadId);
    const cQ = await ask("third");
    await waitFor(() => tui.queue().length === 1);
    const cItem = tui.take();
    const cDone = untilClosed(c, cQ.threadId, cQ.orderId);
    tui.turn(cItem, { status: "completed", answer: "third answer", completedAt: 3 });
    expect(replyOf(await cDone)).toBe("third answer");
  });

  it("an answer interrupted in the TUI (Esc) declines as unavailable; CAFE_DECLINE declines on topic", async () => {
    const { tui, c, ask } = await setup();
    const a = await ask("long");
    await waitFor(() => tui.queue().length === 1);
    const aItem = tui.take();
    const aDone = untilClosed(c, a.threadId, a.orderId);
    tui.turn(aItem, { status: "interrupted", completedAt: 5 });
    expect(declineOf(await aDone)).toMatchObject({ unavailable: true });

    const b = await ask("billing?");
    await waitFor(() => tui.queue().length === 1);
    const bItem = tui.take();
    const bDone = untilClosed(c, b.threadId, b.orderId);
    tui.turn(bItem, { status: "completed", answer: "CAFE_DECLINE: billing is not mine", completedAt: 6 });
    expect(declineOf(await bDone)).toMatchObject({ reason: "billing is not mine" });
  });

  it("--thread pins the session; with no session in the directory it declines as unavailable", async () => {
    const pinned = await setup({
      thread: "old",
      threads: (dir) => [
        { id: "old", cwd: dir, updatedAt: 100, ephemeral: false },
        { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
      ],
    });
    const a = await pinned.ask("pinned?");
    await waitFor(() => pinned.tui.queue("old").length === 1);
    expect(pinned.tui.queue("live")).toEqual([]);
    const item = pinned.tui.take("old");
    const done = untilClosed(pinned.c, a.threadId, a.orderId);
    pinned.tui.turn(item, { status: "completed", answer: "from old", completedAt: 1 }, "old");
    expect(replyOf(await done)).toBe("from old");
  });

  // #100: the silent default used to be "the most recently updated session in the directory", which in
  // real use is exactly the session the person is typing in. Guessing is not safe; ask for a choice.
  it("refuses to guess between several Codex sessions and lists them", async () => {
    await expect(
      setup({
        threads: (dir) => [
          { id: "old", cwd: dir, updatedAt: 100, ephemeral: false },
          { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
        ],
      }),
    ).rejects.toThrow(/several Codex sessions[\s\S]*live[\s\S]*old[\s\S]*--thread/);
  });

  it("de-duplicates repeated thread/list rows before listing candidates (#107)", async () => {
    await expect(
      setup({
        threads: (dir) => [
          { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
          { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
          { id: "old", cwd: dir, updatedAt: 200, ephemeral: false },
          { id: "old", cwd: dir, updatedAt: 200, ephemeral: false },
        ],
      }),
    ).rejects.toThrow(/several Codex sessions in .*: live, old; pass --thread/);
  });

  it("skips a session that is already running a turn", async () => {
    const { tui, c, ask, logs } = await setup({
      threads: (dir) => [
        { id: "old", cwd: dir, updatedAt: 100, ephemeral: false },
        { id: "live", cwd: dir, updatedAt: 300, ephemeral: false },
      ],
      // Another process sees a running turn as `interrupted` with no `completedAt`.
      beforeBridge: (state) => {
        writeFileSync(join(state, "turns-live.json"), JSON.stringify([{ id: "turn-running", status: "interrupted", completedAt: null, items: [] }]));
      },
    });
    expect(logs.join("\n")).toContain("old");
    const a = await ask("not into the busy one");
    await waitFor(() => tui.queue("old").length === 1);
    expect(tui.queue("live")).toEqual([]);
    const item = tui.take("old");
    const done = untilClosed(c, a.threadId, a.orderId);
    tui.turn(item, { status: "completed", answer: "from the idle session", completedAt: 2 }, "old");
    expect(replyOf(await done)).toBe("from the idle session");
  });

  it("refuses to start when there is no Codex session in its directory", async () => {
    await expect(setup({ threads: () => [] })).rejects.toThrow(/no Codex session/);
  });
});

describe("supervised Codex TUI Barista", () => {
  it("barista start --agent codex --tui runs one worker whatever the concurrency, registered as a TUI session", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-sup-codex-tui-"));
    const dir = join(tmp, "work");
    const state = join(tmp, "state");
    mkdirSync(dir);
    mkdirSync(state);
    writeFileSync(join(dir, ".cafe"), "name: tuicoder\ndescription: answers in the running codex session\nconcurrency: 3\n");
    // A TUI Barista now preflights the directory (#40), so give it a session to find.
    writeFileSync(join(state, "threads.json"), JSON.stringify([{ id: "live", cwd: dir, updatedAt: 1, ephemeral: false }]));
    process.env.CAFE_CODEX_BIN = FAKE;
    process.env.FAKE_CODEX_STATE = state;
    const root = await startDaemon("root", { mode: "root", noSupervisor: false });
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    cleanup.push(root.stop);
    cleanup.push(() => {
      delete process.env.CAFE_CODEX_BIN;
      delete process.env.FAKE_CODEX_STATE;
    });
    const workers = root.daemon.supervisor!.start({ dir, agent: "codex", tui: true });
    expect(workers).toHaveLength(1);
    await waitFor(() => root.daemon.registry.all().some((r) => r.name === "tuicoder" && r.status === "idle"), 15_000);
    expect(root.daemon.registry.all().filter((r) => r.name === "tuicoder")).toMatchObject([{ mode: "tui", agent: "codex" }]);
    expect(JSON.parse(readFileSync(join(root.home, "baristas.json"), "utf8"))).toMatchObject([{ dir, agent: "codex", tui: true }]);
  }, 30_000);
});

// #82: `barista start --agent codex --tui` said "started" in a directory with no Codex session;
// the worker then failed in the background forever and nothing told the person why.
describe("barista start reports a Barista that cannot start (#82)", () => {
  const BIN = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/bin/cafe.js");
  function cli(addr: string, env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, CAFE_DAEMON: addr, CAFE_TOKEN: "t0k", ...env } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => done({ status, stdout, stderr }));
    });
  }
  function workDir(name: string) {
    const tmp = mkdtempSync(join(tmpdir(), "cafe-82-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const dir = join(tmp, "work");
    const state = join(tmp, "state");
    mkdirSync(dir);
    mkdirSync(state);
    writeFileSync(join(dir, ".cafe"), `name: ${name}\ndescription: probe\nrole: barista\n`);
    writeFileSync(join(state, "threads.json"), "[]");
    return { tmp, dir, state };
  }

  it("fails before starting anything when the directory has no Codex session", async () => {
    const { dir, state } = workDir("tuiprobe");
    const root = await startDaemon("root", { mode: "root", noSupervisor: false });
    cleanup.push(root.stop);
    const r = await cli(root.addr, { CAFE_CODEX_BIN: FAKE, FAKE_CODEX_STATE: state }, "barista", "start", "--agent", "codex", "--tui", "--dir", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no Codex session in ${dir}`);
    expect(r.stderr).toContain("next: start codex");
    expect(root.daemon.supervisor!.list()).toEqual([]);
  }, 20_000);

  it("reports a worker that exits at once, with its reason and log, and leaves nothing behind", async () => {
    const { tmp, dir } = workDir("crashes");
    const bin = join(tmp, "fails.sh");
    writeFileSync(bin, "#!/bin/sh\necho 'cafe: this worker cannot start here' >&2\nexit 1\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(bin, 0o755);
    process.env.CAFE_PI_BIN = bin;
    cleanup.push(() => void delete process.env.CAFE_PI_BIN);
    const root = await startDaemon("root", { mode: "root", noSupervisor: false });
    cleanup.push(root.stop);
    const r = await cli(root.addr, {}, "barista", "start", "--dir", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("this worker cannot start here");
    expect(r.stderr).toMatch(/barista-work-[0-9a-f]{8}-1\.log/);
    expect(root.daemon.supervisor!.list()).toEqual([]);
  }, 30_000);
});

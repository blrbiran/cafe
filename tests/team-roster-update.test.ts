import { afterEach, describe, expect, it } from "vitest";
import { TeamSpec, Methods } from "@cafe/protocol";
import { barista, identity, startDaemon, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("team roster updates", () => {
  it("refreshes the orchestrator in a member's team context after re-duty", async () => {
    const daemon = await startDaemon("roster-update", { mode: "root" });
    cleanup.push(daemon.stop);

    const publish = (members: Array<{ name: string; duty: string }>) =>
      daemon.daemon.publishRoster(
        daemon.home,
        TeamSpec.parse({
          name: "shop",
          channel: "shop",
          members: members.map((member) => ({ ...member, channels: ["shop"] })),
        }),
      );

    publish([
      { name: "lead", duty: "orchestrator" },
      { name: "developer", duty: "developer" },
    ]);
    const lead = await barista(daemon.addr, identity("lead", { team: "shop", teamChannel: "shop", member: "lead", duty: "orchestrator", channels: ["shop"] }));
    const developer = await barista(daemon.addr, identity("developer", { team: "shop", teamChannel: "shop", member: "developer", duty: "developer", channels: ["shop"] }));
    cleanup.push(() => lead.client.close(), () => developer.client.close());

    expect(developer.client.teamContext?.orchestrator).toBe("lead");
    const initialRevision = developer.client.teamContext!.revision!;
    const updates: unknown[] = [];
    developer.client.onRoster((update) => updates.push(update));

    publish([
      { name: "lead", duty: "developer" },
      { name: "developer", duty: "orchestrator" },
    ]);

    await waitFor(() => developer.client.teamContext?.orchestrator === "developer");
    expect(developer.client.teamContext?.playbook).toContain("orchestrator (front door) is developer");
    expect(updates).toHaveLength(1);

    (daemon.daemon as unknown as { notifyAgent: (agentId: string, method: string, params: unknown) => void }).notifyAgent(
      developer.rec.agentId,
      Methods.teamRoster,
      {
        update: {
          team: "shop",
          channel: "shop",
          revision: initialRevision,
          members: [
            { name: "lead", duty: "orchestrator", online: true },
            { name: "developer", duty: "developer", online: true },
          ],
          change: { added: [], removed: [], updated: [] },
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(developer.client.teamContext?.orchestrator).toBe("developer");
    expect(developer.client.teamContext?.revision).toBeGreaterThan(initialRevision);
    expect(updates).toHaveLength(1);
  });
});

/**
 * The "add another machine" text `cafe root show` prints on a Root (#18, #95). A Root on a LAN and a
 * VPN is reached at a different address from each network; only the person knows which one the other
 * machine can reach, so every candidate is printed unless `advertise` pins one.
 */
export function joinText(j: { addresses: string[]; advertised: boolean; fingerprint?: string; invitationRequired?: boolean }): { commands: string[]; text: string } {
  const invite = j.invitationRequired ? " --invite <code>" : "";
  const commands = j.addresses.map((a) => `cafe connect ${a} --token <token>${invite}${j.fingerprint ? ` --ca-fingerprint sha256:${j.fingerprint}` : ""}`);
  const token = "  (<token>: run `cafe config get token` on this Root)" +
    (j.invitationRequired ? "\n  (<code>: run `cafe host invite` on this Root for a fresh one-use invitation)\n  After connecting, run `cafe daemon restart` on the joining machine." : "");
  if (commands.length <= 1) return { commands, text: `to add another machine, run there:\n  ${commands[0] ?? ""}\n${token}` };
  const text = [
    `to add another machine, run there (this Root has ${commands.length} addresses; use the one that machine can reach):`,
    ...commands.map((c) => `  ${c}`),
    token,
    "  (to offer only one address: cafe config set advertise <address>, then cafe daemon restart)",
  ].join("\n");
  return { commands, text };
}

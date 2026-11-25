/**
 * The `web:` line of `cafe daemon status` (v4-9): the local address, and the encrypted one another
 * device should open (the TLS port serves the same Web UI). Further addresses are in Web Settings.
 */
export function webLine(base: string, https: string[] | undefined): string {
  const local = `${base.replace(/\/$/, "")}/ (this machine)`;
  if (!https?.length) return local;
  const more = https.length > 1 ? `; +${https.length - 1} more in Settings` : "";
  return `${local} · ${https[0]} (other devices, encrypted${more})`;
}

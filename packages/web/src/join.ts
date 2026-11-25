/** What `GET /api/settings` says about joining this Root (#18, #95). Older daemons send only `address`. */
export interface JoinHint {
  address: string;
  addresses?: string[];
  advertised?: boolean;
  caFingerprint?: string;
}

/** One `cafe connect` command per candidate address (#95). The token stays a placeholder. */
export function joinCommands(j: JoinHint): string[] {
  const list = j.addresses?.length ? j.addresses : [j.address];
  return list.map((a) => `cafe connect ${a} --token <token>${j.caFingerprint ? ` --ca-fingerprint ${j.caFingerprint}` : ""}`);
}

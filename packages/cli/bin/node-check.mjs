// Plain ESM (no TypeScript) so an old Node can run this check before it tries to load src/main.ts.
export const MIN_NODE = "22.19";

/** `undefined` when `version` is new enough, otherwise the user-facing message. */
export function nodeVersionError(version) {
  const [major, minor] = String(version)
    .split(".")
    .map((n) => Number(n));
  if (Number.isFinite(major) && (major > 22 || (major === 22 && Number.isFinite(minor) && minor >= 18))) return undefined;
  return `cafe requires Node >= ${MIN_NODE}; current: ${version}\nnext: nvm use 22 || install Node ${MIN_NODE}+`;
}

export function checkNode() {
  const err = nodeVersionError(process.versions.node);
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

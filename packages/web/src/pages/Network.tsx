import { useStore } from "../store.ts";
import { relTime, stamp, useNow } from "../format.ts";
import { Badge, Empty, Led, PageHeader } from "../ui/bits.tsx";

export function NetworkPage() {
  const daemons = useStore((s) => s.daemons);
  const host = useStore((s) => s.host);
  const isRoot = useStore((s) => s.isRoot);
  const router = useStore((s) => s.router);
  const version = useStore((s) => s.registryVersion);
  const rootOnline = useStore((s) => s.rootOnline);
  const now = useNow();
  const sorted = [...daemons].sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.host.localeCompare(b.host));

  return (
    <>
      <PageHeader title="Network" meta={isRoot ? "root daemon: full topology" : "child daemon: this host and its root"} />
      <div className="mb-4 grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <Tile label="this host" value={host} />
        <Tile label="role" value={isRoot ? "root" : "daemon"} />
        <Tile label="router" value={router} />
        <Tile label="registry" value={`v${version}`} />
      </div>
      {!isRoot && !rootOnline && (
        <div role="status" className="well mb-4 text-sm" data-tone="warn">
          Root unreachable: orders stay on this host; cross-host orders fail with root_unreachable.
        </div>
      )}
      {sorted.length === 0 ? (
        <Empty>No daemons known.</Empty>
      ) : (
        <section className="card table-box">
          <table>
            <thead>
              <tr>
                <th>Host</th>
                <th>URL</th>
                <th>Role</th>
                <th>Status</th>
                <th>Connected</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={`${d.host}-${d.isRoot}`}>
                  <td className="whitespace-nowrap text-fg-strong">
                    {d.host}
                    {d.host === host && <span className="meta ml-2">(this)</span>}
                  </td>
                  <td className="meta">{d.url || "—"}</td>
                  <td>{d.isRoot ? <Badge tone="info">root</Badge> : <Badge>daemon</Badge>}</td>
                  <td className="whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <Led status={d.online ? "idle" : "offline"} />
                      {d.online ? "online" : "offline"}
                    </span>
                  </td>
                  <td className="meta whitespace-nowrap num">{stamp(d.connectedAt)}</td>
                  <td className="meta whitespace-nowrap num">{relTime(d.lastSeenAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="well">
      <div className="meta uppercase">{label}</div>
      <div className="truncate font-data text-base text-fg-strong">{value || "—"}</div>
    </div>
  );
}

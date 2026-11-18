import { useEffect } from "react";
import { Shell } from "./Shell.tsx";
import { useRoute } from "./route.ts";
import { closeThread, openThread, useStore } from "./store.ts";
import { AgentsPage } from "./pages/Agents.tsx";
import { ThreadsPage } from "./pages/Threads.tsx";
import { ThreadPage } from "./pages/Thread.tsx";
import { NetworkPage } from "./pages/Network.tsx";

export function App() {
  const route = useRoute();
  const error = useStore((s) => s.error);
  const loaded = useStore((s) => s.loaded);
  const threadId = route.page === "thread" ? route.threadId : undefined;

  useEffect(() => {
    if (threadId) void openThread(threadId);
    else closeThread();
  }, [threadId]);

  return (
    <Shell route={route}>
      {error && (
        <div role="alert" className="well mb-4 text-sm" data-tone="danger">
          {error}
        </div>
      )}
      {!loaded ? (
        <div className="meta">loading…</div>
      ) : route.page === "agents" ? (
        <AgentsPage />
      ) : route.page === "network" ? (
        <NetworkPage />
      ) : route.page === "thread" ? (
        <ThreadPage threadId={route.threadId} />
      ) : (
        <ThreadsPage status={route.status} agent={route.agent} />
      )}
    </Shell>
  );
}

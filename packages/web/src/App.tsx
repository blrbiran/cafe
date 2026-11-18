import { useEffect } from "react";
import { Shell } from "./Shell.tsx";
import { useRoute } from "./route.ts";
import { closeThread, openThread, useStore } from "./store.ts";
import { useT } from "./i18n.ts";
import { FeedPage } from "./pages/Feed.tsx";
import { ConversationPage } from "./pages/Conversation.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { NetworkPage } from "./pages/Network.tsx";

export function App() {
  const t = useT();
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
        <div role="alert" className="well text-sm" data-tone="danger">
          {error}
        </div>
      )}
      {!loaded ? (
        <div className="hint">{t.loading}</div>
      ) : route.page === "agents" ? (
        <AgentsPage />
      ) : route.page === "network" ? (
        <NetworkPage />
      ) : route.page === "thread" ? (
        <ConversationPage threadId={route.threadId} />
      ) : (
        <FeedPage filter={route.filter} />
      )}
    </Shell>
  );
}

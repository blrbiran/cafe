import { CafeClient } from "@cafe/protocol/client";
import { managedAgentResumeStore } from "@cafe/protocol/cafe-file";

const [daemon, stateFile, phase] = process.argv.slice(2);
const client = new CafeClient({ daemon, resumeStore: managedAgentResumeStore(stateFile) });
process.on("disconnect", () => { client.close(); process.exit(); });
client.onOrder((handle) => {
  process.send({ kind: "execution", orderId: handle.order.orderId });
  if (phase === "resume") {
    void handle.ack().then(() => handle.reply("finished after receipt recovery")).catch((error) => {
      process.send({ kind: "error", message: error.message });
    });
  }
});
try {
  const record = await client.connect({ name: "worker", role: "barista", mode: "headless", cwd: process.cwd(), description: "", tags: [], scope: [], concurrency: 1 });
  process.send({ kind: "ready", agentId: record.agentId });
} catch (error) {
  process.send({ kind: "error", message: error.message });
  client.close();
  process.exitCode = 1;
}

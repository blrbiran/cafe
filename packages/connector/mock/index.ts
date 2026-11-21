import { createMockConnector, isEntryPoint } from "@cafe/connector/mock";

/** `CAFE_HOME/connectors/mock/index.ts`; reads platform events on stdin. */
const main = createMockConnector();

export default main;

if (isEntryPoint(import.meta.url)) {
  main.run().catch((err) => {
    process.stderr.write(`mock connector: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
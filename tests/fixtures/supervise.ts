// Runs a Supervisor in its own process so a test can SIGKILL it and watch the workers die with it.
// env: SUP_HOME, SUP_DIR, CAFE_PI_BIN (fake pi), FAKE_PI_PIDFILE.
import { Supervisor } from "../../packages/daemon/src/supervisor.ts";

const sup = new Supervisor({ home: process.env.SUP_HOME!, daemonAddr: "127.0.0.1:1", token: "t", graceMs: 500 });
sup.start({ dir: process.env.SUP_DIR! });
process.stdout.write("READY\n");
setInterval(() => {}, 1000);

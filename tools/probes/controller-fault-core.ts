import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../apps/desktop/src/core/main";
import { RunService } from "../../apps/desktop/src/core/runs/service";

void run({
  moduleDir: __dirname,
  runsFactory: (context, collab) =>
    new RunService({
      context,
      collab,
      effectProbe: (point, task) => {
        const marker = join(context.dataDir, "probe-fault.json");
        if (point === process.env.ARMADRA_PROBE_FAULT && !existsSync(marker)) {
          writeFileSync(marker, JSON.stringify({ point, taskId: task.id }), {
            mode: 0o600,
          });
          process.kill(process.pid, "SIGKILL");
        }
      },
    }),
}).catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});

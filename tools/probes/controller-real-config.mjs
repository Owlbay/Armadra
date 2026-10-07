import { spawn } from "node:child_process";

export function probeEnvironment(env) {
  const result = { ...env };
  for (const key of Object.keys(result))
    if (
      /CADK|ARMADRA_NODE_ID|ARMADRA_SESSION|CODEX_THREAD|CODEX_SESSION/.test(
        key,
      )
    )
      delete result[key];
  return result;
}

/** Native parsed config only: never starts a thread or sends a model prompt. */
export async function readCodexConfig(program, home, cwd, env = process.env) {
  const child = spawn(
    program,
    ["app-server", "--stdio", "-c", "check_for_update_on_startup=false"],
    {
      cwd,
      env: { ...probeEnvironment(env), CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  let buffer = "",
    timer,
    completed = false;
  try {
    return await new Promise((done, fail) => {
      const reject = () => {
        if (!completed) {
          completed = true;
          fail(new Error("Native Codex config probe unavailable"));
        }
      };
      child.once("error", reject);
      child.once("exit", reject);
      child.stdin.on("error", reject);
      child.stdout.on("error", reject);
      timer = setTimeout(reject, 10000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) {
          reject();
          return;
        }
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          let message;
          try {
            message = JSON.parse(buffer.slice(0, index));
          } catch {
            reject();
            return;
          }
          buffer = buffer.slice(index + 1);
          if (message.error) {
            reject();
            return;
          }
          if (message.id === 1) {
            child.stdin.write(
              JSON.stringify({ method: "initialized", params: {} }) + "\n",
            );
            child.stdin.write(
              JSON.stringify({
                id: 2,
                method: "config/read",
                params: { cwd, includeLayers: true },
              }) + "\n",
            );
          }
          if (message.id === 2 && message.result) {
            completed = true;
            done(message.result);
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "armadra-real-preflight", version: "1" },
            capabilities: { experimentalApi: true },
          },
        }) + "\n",
      );
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((done) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 1000);
        child.once("exit", () => {
          clearTimeout(timeout);
          done();
        });
      });
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

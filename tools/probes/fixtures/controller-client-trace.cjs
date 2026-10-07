/** Host-proof measurement only: never loaded by the distributed client. */
const { appendFileSync, statSync } = require("node:fs");
if (
  process.env.ARMADRA_PROBE_TRACE &&
  process.argv[1] === process.env.ARMADRA_PROBE_CLIENT
) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  let inputFileBytes = 0;
  if (fileIndex >= 0 && args[fileIndex + 1] !== "-") {
    try {
      inputFileBytes = statSync(args[fileIndex + 1]).size;
    } catch {}
  }
  let outputBytes = 0;
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    outputBytes += Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(chunk);
    return write.call(this, chunk, ...rest);
  };
  process.once("exit", (exitCode) => {
    appendFileSync(
      process.env.ARMADRA_PROBE_TRACE,
      JSON.stringify({
        method: args.slice(0, 2).join(" "),
        exitCode,
        argumentBytes: Buffer.byteLength(JSON.stringify(args)),
        inputFileBytes,
        outputBytes,
      }) + "\n",
      { mode: 0o600 },
    );
  });
}

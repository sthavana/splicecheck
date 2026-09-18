/**
 * Runs the dev server with a wake lock held, for monitoring sessions.
 *
 * The poll loop is an ordinary setInterval in this process, so it only runs
 * while the machine is awake. A Mac left alone drops into maintenance sleep for
 * about four minutes at a stretch and wakes for about forty-five seconds,
 * which produced a monitoring timeline that was roughly 15% covered — long
 * silences that look identical to a healthy quiet period.
 *
 *   npm run monitor
 *
 * caffeinate -i asserts only "do not idle-sleep"; the display still sleeps and
 * a lid close still suspends. The lock lasts exactly as long as this process.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

const args = ["next", "dev", ...process.argv.slice(2)];

let cmd = "npx";
let cmdArgs = args;
let note = "no wake lock on this platform — the poll loop stops whenever the machine sleeps";

if (platform() === "darwin") {
  // -i: prevent idle sleep. -m: keep the disk awake for the SQLite writes.
  cmd = "caffeinate";
  cmdArgs = ["-im", "npx", ...args];
  note = "holding a wake lock (caffeinate -im) for as long as this runs";
}

console.log(`\n  monitor mode: ${note}\n`);

const child = spawn(cmd, cmdArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

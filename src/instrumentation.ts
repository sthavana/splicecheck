export async function register() {
  // Only the Node.js server runtime can hold the poller and the SQLite handle.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("./lib/monitor");
  startScheduler();
}

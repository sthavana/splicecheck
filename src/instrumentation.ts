export async function register() {
  // Only the Node.js server runtime can hold the poller and the SQLite handle.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // On a serverless platform there is no process between requests to poll from,
  // so don't load the native database driver at boot just to do nothing with it.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    const { startScheduler } = await import("./lib/monitor");
    startScheduler();
  } catch (e) {
    // A monitor that cannot start must not take the rest of the app down.
    console.error("SpliceCheck: monitor scheduler did not start:", e);
  }
}

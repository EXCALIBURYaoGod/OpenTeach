/**
 * The process-scoped signal handlers for the boot-time teardown.
 *
 * This lives outside `instrumentation.ts` because Next.js flags `process.once`
 * in the Edge compilation of that file at BUILD time: the check is static, so
 * the `NEXT_RUNTIME` guard around the call site does not suppress it, and the
 * warning is re-emitted on every recompile until real problems are hard to find
 * in the log. The Edge bundle only avoids this module because `register()` pulls
 * it in through a dynamic import from its Node branch.
 */

/**
 * Registers the one-shot SIGTERM / SIGINT drain.
 *
 * `once`, not `on`: `shutdown` memoises its own promise, but the handlers
 * themselves should not multiply if a signal is delivered twice.
 */
export function registerShutdownHandlers(shutdown: () => Promise<void>): void {
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

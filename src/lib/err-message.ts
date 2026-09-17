/**
 * Render an unknown error to a string for logging. Returns `e.message` for
 * Error values (the stack stays out of warn/error lines — debug paths that
 * want the trace render it themselves) and `String(...)` for every primitive.
 *
 * A thrown PLAIN OBJECT gets its own branch: `String({ code: "ECONNRESET" })`
 * is `[object Object]`, so a rejected fetch/HTTP object used to reach the log
 * with nothing in it a reader could act on. `JSON.stringify` renders the
 * fields instead; it returns `undefined` for a value it cannot represent and
 * THROWS on a circular structure or a BigInt field — a logger that throws
 * inside a catch block turns a handled failure into an unhandled rejection,
 * so both outcomes fall back to the type tag.
 *
 * This file stays import-free on purpose: the admin component under
 * `src-admin/` imports it too (relative path into `src/lib/`, measured to work
 * with the Module-Federation build), so it lands in both bundles — a
 * dependency here would be dragged into both.
 *
 * @param e Caught value (usually `unknown` in catch blocks)
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "object" && e !== null) {
    try {
      return JSON.stringify(e) ?? Object.prototype.toString.call(e);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  return String(e);
}

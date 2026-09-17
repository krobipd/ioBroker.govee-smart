/**
 * Render a caught value to text — the admin component's copy of the adapter's
 * `errMessage` (`src/lib/types.ts`; the component is its own build and cannot
 * import from the adapter). Same contract for every thrown value: `Error` →
 * `message`, string → itself, other primitives → `String()`, plain object →
 * its fields. `JSON.stringify` throws on a circular structure and returns
 * `undefined` for a value it cannot represent, so both fall back to the type
 * tag — a helper that throws inside a catch block turns a handled failure into
 * an unhandled one.
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

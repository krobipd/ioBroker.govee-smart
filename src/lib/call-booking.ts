import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The error codes of a connection that was never established: the name did not
 * resolve (`ENOTFOUND`, `EAI_AGAIN`), the server refused the connection, or no
 * route led there. A request that failed with one of them BEFORE its socket
 * connected never reached Govee (issue #51). `ETIMEDOUT`, `ECONNRESET` and TLS
 * errors are not in the list: such a request may have been received.
 */
const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * One cloud call the rate limiter has booked. The HTTP client reports every
 * request made under it; the limiter asks at the end whether the booking has to
 * be given back — when no request of it reached Govee, Govee counted nothing and
 * the adapter's mirror of Govee's limits must not count it either.
 */
export class Booking {
  private delivered = false;
  private notDelivered = false;
  private sealed = false;

  /**
   * Record one request made under this booking. Ignored once the booking is
   * sealed: work the call started without awaiting it (a token refresh, a late
   * timer) inherits the booking and must not change its verdict afterwards.
   *
   * @param delivered Whether the request may have reached Govee
   */
  attempt(delivered: boolean): void {
    if (this.sealed) {
      return;
    }
    if (delivered) {
      this.delivered = true;
    } else {
      this.notDelivered = true;
    }
  }

  /**
   * Close the booking.
   *
   * @returns true when it must be given back: a request failed before reaching
   *   Govee and none reached it — a call that made no request at all keeps its booking
   */
  seal(): boolean {
    this.sealed = true;
    return this.notDelivered && !this.delivered;
  }
}

const storage = new AsyncLocalStorage<Booking>();

/**
 * Run a booked call so that every request it makes can report to the booking.
 *
 * @param booking The booking the call runs under
 * @param fn The call
 */
export function runBooked<T>(booking: Booking, fn: () => Promise<T>): Promise<T> {
  return storage.run(booking, fn);
}

/**
 * The booking of the call that is running right now, if any. Read it
 * synchronously when a request starts — a listener may run in another call's
 * context (a queued keep-alive request is opened from the one that freed its slot).
 */
export function currentBooking(): Booking | undefined {
  return storage.getStore();
}

/**
 * Whether a failed request provably never reached Govee: its socket never
 * connected and the error is one of a connection that was never established.
 *
 * @param err The request error
 * @param connected Whether the request's socket had connected
 */
export function isNeverSent(err: unknown, connected: boolean): boolean {
  if (connected) {
    return false;
  }
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NEVER_CONNECTED_CODES.has(code);
}

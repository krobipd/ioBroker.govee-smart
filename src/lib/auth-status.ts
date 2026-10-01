// The connection card's `mqttAuth` contract: the cases the adapter answers with and the answer's shape.
// Import-free, because the card (src-admin) imports it too — router and card read the SAME list (audit
// DRY-13; until 3.1.0 both declared the type and the card held a third copy as a Set). The answer is data
// only: the card words every case in the admin's language, the adapter sends no sentence.

/** Every case a `mqttAuth` action answers with (superset of both actions). */
export const AUTH_STATUSES = [
  "ok",
  "verifyRequired",
  "codeInvalid",
  "passwordRejected",
  "emailNotRegistered",
  "rateLimited",
  "accountLocked",
  "loginWindowFull",
  "loginFailed",
  "mqttNotUp",
  "codeSent",
  "codeRejected",
  "needCredentials",
  "throttled",
  "unknownAction",
] as const;

/** Machine-readable outcome of a `mqttAuth` action. */
export type AuthStatus = (typeof AUTH_STATUSES)[number];

/** Structured `mqttAuth` answer. */
export interface AuthResponse {
  /** The case the card reacts to and words. */
  status: AuthStatus;
  /** Govee's or the client's own reason (`loginFailed`, `codeRejected`). */
  reason?: string;
  /** When the next login is possible, ms epoch (`loginWindowFull`). */
  retryAt?: number;
}

/** Credentials the user is currently editing in the card, sent with the action. */
export interface AuthCreds {
  /** Account email (falls back to the saved config when omitted). */
  email?: string;
  /** Account password (falls back to the saved config when omitted). */
  password?: string;
  /** 2FA verification code (falls back to the saved config when omitted). */
  code?: string;
}

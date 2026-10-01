// The one rule for the Govee account fields — the start, the ready summary and the connection card's "Test login"
// used to judge them three ways.

/**
 * The account e-mail as the login sends it — trimmed: a pasted trailing space must not make the card's test succeed
 * and the start-up login fail on the same value (issue #39).
 *
 * @param email The e-mail as entered (saved setting or the card's live field)
 */
export function accountEmail(email: string | undefined): string {
  return (email ?? "").trim();
}

/**
 * E-mail and password are both entered. The password counts only with more than whitespace, but it is sent as typed —
 * surrounding spaces can be part of it.
 *
 * @param email The e-mail as entered
 * @param password The password as entered
 */
export function hasAccountCredentials(email: string | undefined, password: string | undefined): boolean {
  return accountEmail(email) !== "" && (password ?? "").trim() !== "";
}

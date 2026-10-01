import { accountEmail, hasAccountCredentials } from "./account-credentials";

describe("account credentials — one rule for start, ready summary and the card's test", () => {
  it("the e-mail is sent trimmed", () => {
    expect(accountEmail("  a@b.c ")).toBe("a@b.c");
    expect(accountEmail(undefined)).toBe("");
  });

  it("both fields must carry more than whitespace", () => {
    expect(hasAccountCredentials("a@b.c", "pw")).toBe(true);
    expect(hasAccountCredentials("  ", "pw")).toBe(false);
    expect(hasAccountCredentials("a@b.c", "   ")).toBe(false);
    expect(hasAccountCredentials(undefined, "pw")).toBe(false);
    expect(hasAccountCredentials("a@b.c", undefined)).toBe(false);
  });

  it("a password with surrounding spaces still counts — it is sent as typed", () => {
    expect(hasAccountCredentials("a@b.c", " pw ")).toBe(true);
  });
});

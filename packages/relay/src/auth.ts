/**
 * TODO(#121): Better Auth is not wired up yet. Once it lands, this becomes a
 * real lookup — validate the bearer token against Better Auth's session
 * store and return the account it resolves to (or throw/close the
 * connection on an invalid token). Until then the relay treats the raw
 * `authToken` string itself as the account identity: every device that
 * presents the same token is scoped to the same account, which is enough to
 * exercise account-scoped session listing and device registries in tests,
 * but it is NOT authentication — any non-empty string is accepted.
 */
export function deriveAccountIdStub(authToken: string): string {
  return authToken;
}

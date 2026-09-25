/**
 * src/lib/user-identity.ts
 *
 * How admin surfaces label an account.
 *
 * `username` is unique and immutable; `displayName` is a mutable, non-unique
 * alias a user sets for themselves. Whenever an operator has to tell accounts
 * apart (tables, owner columns, pickers, delete confirmations) we therefore
 * lead with the username and only append the display name when it actually
 * adds information. That way admin actions stay unambiguous even when several
 * accounts share a display name.
 */
export function formatUserIdentity(
  username: string,
  displayName?: string | null,
): string {
  const alias = displayName?.trim();
  if (!alias || alias === username) return username;
  return `${username} (${alias})`;
}

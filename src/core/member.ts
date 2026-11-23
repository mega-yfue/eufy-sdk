/** The `member.admin_user_id` a raw device record states, as esiotkit's `FamilyMember.adminUserId` reads it. @internal */
export function adminUserIdOf(raw: unknown): string | undefined {
  const id = (raw as { member?: Record<string, unknown> } | undefined)?.member?.admin_user_id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * The account id the app sends for a device record (`AnkerAccountManager.e`, and `.u` on the station's record): its
 * `member.admin_user_id` when it states one, `member_type` is not 2 and `member_user_id` is the signed-in user,
 * else the signed-in user's own id (`""` signed out). @internal
 */
export function memberAccountId(raw: unknown, ownUserId: string | undefined): string {
  const member = (raw as { member?: Record<string, unknown> } | undefined)?.member;
  const admin = adminUserIdOf(raw);
  return admin && member!.member_type !== 2 && ownUserId && member!.member_user_id === ownUserId
    ? admin
    : (ownUserId ?? "");
}

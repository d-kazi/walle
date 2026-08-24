import type { User } from '../types/domain.js';

/**
 * The two-entry allow-list (hard rule 1). Maps channel sender ids to users
 * and back. Nothing outside this map can ever be a recipient.
 */
export class AllowList {
  private readonly byWaId: Map<string, User>;
  private readonly byUser: Map<User, string>;

  constructor(waIdDan: string, waIdAlina: string) {
    this.byWaId = new Map([
      [waIdDan, 'dan'],
      [waIdAlina, 'alina'],
    ]);
    this.byUser = new Map([
      ['dan', waIdDan],
      ['alina', waIdAlina],
    ]);
  }

  resolveUser(senderId: string): User | null {
    return this.byWaId.get(senderId) ?? null;
  }

  waIdFor(user: User): string {
    const id = this.byUser.get(user);
    if (!id) throw new Error(`No wa_id configured for ${user}`);
    return id;
  }
}

// Every other guard in txguard compares the transaction bytes against what the
// server said. The fee payer needs more than that, because the server picks the
// claim as well as the bytes — so on its own, "the bytes match the claim" would
// let a server name the user as fee payer and be believed.
import { describe, expect, it } from 'vitest';
import { assertFeePayerAllowed } from '../src/txguard.js';

const SPONSOR = 'SponsorAddress1111111111111111111111111111';
const OWNER = 'OwnerAddress111111111111111111111111111111';
const STRANGER = 'StrangerAddress11111111111111111111111111';

describe('assertFeePayerAllowed', () => {
  it('accepts the sponsor paying', () => {
    const role = assertFeePayerAllowed(
      { feePayer: SPONSOR, feePayerRole: 'sponsor' },
      SPONSOR,
      OWNER,
    );
    expect(role).toBe('sponsor');
  });

  it('accepts the owner paying when the server says so', () => {
    const role = assertFeePayerAllowed({ feePayer: OWNER, feePayerRole: 'owner' }, SPONSOR, OWNER);
    expect(role).toBe('owner');
  });

  // The attack the role field exists to stop: quietly bill the user while the
  // screen still reads "network fee — paid for you".
  it('refuses the owner paying under a sponsor claim', () => {
    expect(() =>
      assertFeePayerAllowed({ feePayer: OWNER, feePayerRole: 'sponsor' }, SPONSOR, OWNER),
    ).toThrowError(/not the sponsor/i);
  });

  it('refuses a third party paying, whatever the claim', () => {
    expect(() =>
      assertFeePayerAllowed({ feePayer: STRANGER, feePayerRole: 'sponsor' }, SPONSOR, OWNER),
    ).toThrowError(/not the sponsor/i);

    expect(() =>
      assertFeePayerAllowed({ feePayer: STRANGER, feePayerRole: 'owner' }, SPONSOR, OWNER),
    ).toThrowError(/names a different account/i);
  });

  // An older server predates the field. Treating "absent" as "sponsor" keeps
  // the strict reading rather than the permissive one.
  it('treats a missing role as the sponsor paying', () => {
    expect(assertFeePayerAllowed({ feePayer: SPONSOR }, SPONSOR, OWNER)).toBe('sponsor');
    expect(() => assertFeePayerAllowed({ feePayer: OWNER }, SPONSOR, OWNER)).toThrowError(
      /not the sponsor/i,
    );
  });
});

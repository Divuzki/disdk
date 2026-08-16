/**
 * Generate a sponsor keypair and print what to put in `.env`.
 *
 * The Solana CLI is not required. On devnet this also requests an airdrop so
 * the fee payer can actually pay for approvals.
 */
import { address, createSolanaRpc, lamports } from '@solana/kit';
import { generateSponsorKeypair } from '@disdk/verify';

const cluster = process.argv[2] ?? 'devnet';
const rpcUrl =
  cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';

const { address: sponsorAddress, secretKeyBase64 } = await generateSponsorKeypair();

console.log('Sponsor address :', sponsorAddress);
console.log('');
console.log('Add to apps/server/.env:');
console.log(`SPONSOR_SECRET_KEY=${secretKeyBase64}`);
console.log('');
console.log('This is a hot key that pays every network fee. Keep it out of version control.');

if (cluster === 'devnet') {
  const rpc = createSolanaRpc(rpcUrl);
  try {
    await rpc.requestAirdrop(address(sponsorAddress), lamports(1_000_000_000n)).send();
    console.log('\nRequested a 1 SOL devnet airdrop; it may take a few seconds to land.');
  } catch (error) {
    console.log('\nAirdrop failed (devnet faucets rate limit heavily):', String(error));
    console.log('Fund the address manually at https://faucet.solana.com');
  }
}

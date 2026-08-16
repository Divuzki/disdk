import { createSolanaRpc } from '@solana/kit';

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

export function createRpc(url: string): SolanaRpc {
  return createSolanaRpc(url);
}

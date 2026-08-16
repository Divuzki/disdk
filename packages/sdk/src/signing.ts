/**
 * Getting the wallet's signature onto the sponsored transaction.
 *
 * Two paths exist and both must be supported. `solana:signAndSendTransaction`
 * is the one wallets recommend and is superseding `solana:signTransaction` in
 * the Wallet Standard, so it is tried first: the wallet broadcasts and hands
 * back a signature, which the server then verifies on chain. Where a wallet
 * only offers `solana:signTransaction`, it returns signed bytes and the server
 * verifies them before broadcasting itself.
 *
 * Either way the sponsor stays the fee payer, so the user needs no SOL.
 */

import { DisdkError, type Cluster } from '@disdk/protocol';
import { base58Encode, base64Decode, base64Encode } from './codec.js';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  toWalletError,
  type DiscoveredWallet,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
  type WalletAccount,
} from './wallets.js';

export type SignOutcome =
  | { mode: 'sent'; signature: string }
  | { mode: 'signed'; signedTransaction: string };

export interface SignInput {
  entry: DiscoveredWallet;
  account: WalletAccount;
  chain: Cluster;
  /** Base64 transaction, already carrying the sponsor's signature. */
  transactionBase64: string;
}

export async function signSponsoredTransaction({
  entry,
  account,
  chain,
  transactionBase64,
}: SignInput): Promise<SignOutcome> {
  const transaction = base64Decode(transactionBase64);

  if (entry.supportsSignAndSend) {
    try {
      return await signAndSend(entry, account, chain, transaction);
    } catch (error) {
      // A decline is the user's answer — never retry it down the other path.
      if (error instanceof DisdkError && error.code === 'WALLET_REJECTED') throw error;
      if (!entry.supportsSignTransaction || !looksUnsupported(error)) throw error;
      // Otherwise the wallet advertises the feature but cannot serve it here;
      // fall through to the sign-only path.
    }
  }

  if (entry.supportsSignTransaction) {
    return signOnly(entry, account, chain, transaction);
  }

  throw new DisdkError(
    'UNSUPPORTED_WALLET',
    `${entry.name} cannot sign this transaction.`,
  );
}

async function signAndSend(
  entry: DiscoveredWallet,
  account: WalletAccount,
  chain: Cluster,
  transaction: Uint8Array,
): Promise<SignOutcome> {
  const feature = entry.wallet.features[SolanaSignAndSendTransaction] as
    | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
    | undefined;

  if (!feature) {
    throw new DisdkError('UNSUPPORTED_WALLET', `${entry.name} cannot send transactions.`);
  }

  let outputs;
  try {
    outputs = await feature.signAndSendTransaction({
      account,
      chain,
      transaction,
      options: { preflightCommitment: 'confirmed' },
    });
  } catch (error) {
    throw toWalletError(error, `${entry.name} could not send the transaction.`);
  }

  const signature = outputs[0]?.signature;
  if (!signature) {
    throw new DisdkError('WALLET_REJECTED', `${entry.name} returned no signature.`);
  }

  return { mode: 'sent', signature: base58Encode(new Uint8Array(signature)) };
}

async function signOnly(
  entry: DiscoveredWallet,
  account: WalletAccount,
  chain: Cluster,
  transaction: Uint8Array,
): Promise<SignOutcome> {
  const feature = entry.wallet.features[SolanaSignTransaction] as
    | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
    | undefined;

  if (!feature) {
    throw new DisdkError('UNSUPPORTED_WALLET', `${entry.name} cannot sign transactions.`);
  }

  let outputs;
  try {
    outputs = await feature.signTransaction({ account, chain, transaction });
  } catch (error) {
    throw toWalletError(error, `${entry.name} could not sign the transaction.`);
  }

  const signed = outputs[0]?.signedTransaction;
  if (!signed) {
    throw new DisdkError('WALLET_REJECTED', `${entry.name} returned no signed transaction.`);
  }

  return { mode: 'signed', signedTransaction: base64Encode(new Uint8Array(signed)) };
}

function looksUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported|not (be )?(supported|implemented)|unknown method|no such method/i.test(message);
}

import { createSolanaRpc } from '@solana/kit';
import { DisdkError } from '@disdk/protocol';

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

export function createRpc(url: string): SolanaRpc {
  return createSolanaRpc(url);
}

/**
 * Run an RPC call and turn transport failures into something actionable.
 *
 * Without this, a rate-limited or unreachable RPC endpoint surfaces to the user
 * as an opaque "something went wrong" with no hint that retrying would help —
 * and public Solana endpoints rate-limit aggressively, so this is a routine
 * condition rather than an exotic one.
 */
export async function withRpc<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DisdkError) throw error;

    const status = httpStatusOf(error);
    const detail = error instanceof Error ? error.message : String(error);

    if (status === 429) {
      throw new DisdkError(
        'NETWORK_ERROR',
        'The Solana network endpoint is rate limiting us. Please try again in a moment.',
        true,
      );
    }

    throw new DisdkError(
      'NETWORK_ERROR',
      `Could not reach the Solana network while ${operation}. Please try again. (${detail})`,
      true,
    );
  }
}

function httpStatusOf(error: unknown): number | undefined {
  const context = (error as { context?: { statusCode?: number } } | null)?.context;
  return typeof context?.statusCode === 'number' ? context.statusCode : undefined;
}

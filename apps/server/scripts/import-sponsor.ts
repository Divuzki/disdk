/**
 * Import an existing funded account as the sponsor (fee payer).
 *
 * The secret is read from stdin, never from argv, so it does not land in shell
 * history or the process table. It is written to .env and otherwise only ever
 * used to derive the public address — nothing here prints or transmits it.
 *
 * Accepts the three formats wallets and tools actually emit:
 *   - base58            (Phantom / Solflare "export private key")
 *   - JSON byte array   (solana-keygen, id.json)
 *   - base64            (what `pnpm keygen` prints)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase58Encoder,
} from '@solana/kit';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../.env');

const cluster = process.argv[2] ?? 'mainnet';
const rpcUrl =
  cluster === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';

function decode(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error('Nothing entered.');

  // solana-keygen / id.json
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
      throw new Error('That looks like JSON but is not an array of byte values.');
    }
    return Uint8Array.from(parsed as number[]);
  }

  // base64 carries characters base58 does not, so it is unambiguous when present.
  if (/[+/=]/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, 'base64'));
  }

  // Otherwise prefer base58 (what wallets export) and fall back to base64.
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(trimmed));
    if (bytes.length === 64) return bytes;
  } catch {
    // Not valid base58 — fall through.
  }
  return new Uint8Array(Buffer.from(trimmed, 'base64'));
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((done) => {
    // Mute the echo so the key is not left on screen or in the scrollback.
    const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput(s: string): void };
    process.stdout.write(question);
    output._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer);
    });
  });
}

const secret = await prompt('Paste the sponsor private key (input hidden), then Enter: ');

let bytes: Uint8Array;
try {
  bytes = decode(secret);
} catch (error) {
  console.error('\nCould not read that key:', (error as Error).message);
  process.exit(1);
}

if (bytes.length !== 64) {
  console.error(
    `\nExpected a 64-byte keypair, got ${bytes.length} bytes.\n` +
      'A 32-byte value is a seed or a public key, not a full keypair. Export the\n' +
      'private key from your wallet, or use the id.json that solana-keygen wrote.',
  );
  process.exit(1);
}

const signer = await createKeyPairSignerFromBytes(bytes);
const secretBase64 = Buffer.from(bytes).toString('base64');

console.log(`\nSponsor address : ${signer.address}`);

// Confirm it is actually funded, because an unfunded fee payer fails at submit
// time with an error that points at the transaction rather than at the cause.
try {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getBalance(address(signer.address)).send();
  const sol = Number(value) / 1_000_000_000;
  console.log(`Balance on ${cluster.padEnd(8)}: ${sol} SOL`);
  if (sol === 0) {
    console.log('\nWARNING: this account holds no SOL, so it cannot pay fees yet.');
  }
} catch (error) {
  console.log(`Balance on ${cluster}: could not check (${String(error)})`);
}

const line = `SPONSOR_SECRET_KEY=${secretBase64}`;
let env = '';
try {
  env = await readFile(envPath, 'utf8');
} catch {
  console.error(`\nNo .env at ${envPath}. Copy .env.example to .env first.`);
  process.exit(1);
}

const updated = /^SPONSOR_SECRET_KEY=.*$/m.test(env)
  ? env.replace(/^SPONSOR_SECRET_KEY=.*$/m, line)
  : `${env.trimEnd()}\n${line}\n`;

await writeFile(envPath, updated, 'utf8');
console.log(`\nWrote SPONSOR_SECRET_KEY to ${envPath}`);
console.log('That file is gitignored. Restart the server to pick it up.');

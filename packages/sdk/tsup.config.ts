import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    // The optional mobile package is loaded lazily at runtime; keep it external
    // so bundlers do not force it on desktop consumers.
    external: ['@solana-mobile/wallet-standard-mobile'],
  },
  {
    // Single-file drop-in for a <script> tag. Everything is inlined except the
    // optional MWA package, which stays a dynamic import.
    entry: { disdk: 'src/global.ts' },
    format: ['iife'],
    globalName: 'DisdkBundle',
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    treeshake: true,
    noExternal: [
      '@disdk/protocol',
      '@wallet-standard/app',
      '@wallet-standard/base',
      '@wallet-standard/features',
      '@solana/wallet-standard-features',
      '@solana/wallet-standard-chains',
    ],
    external: ['@solana-mobile/wallet-standard-mobile'],
    outExtension: () => ({ js: '.global.js' }),
  },
]);

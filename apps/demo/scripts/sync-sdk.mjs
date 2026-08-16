/**
 * Copy the built CDN bundle into the demo's static assets.
 *
 * The demo deliberately loads the SDK through a plain <script> tag rather than
 * importing it, because that is the integration path being demonstrated. In a
 * real deployment this file comes from a CDN.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../packages/sdk/dist/disdk.global.js');
const target = resolve(here, '../public/disdk.global.js');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`[demo] synced ${source} -> ${target}`);

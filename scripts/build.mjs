// Bundles main (node/cjs), preload (sandboxed, only `electron` external) and renderer (browser iife).
import { build } from 'esbuild';

const common = { bundle: true, sourcemap: true, logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs',
    external: ['electron', '@smartspectra/node-sdk', '@smartspectra/node-sdk/*'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs',
    external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer.js', platform: 'browser', format: 'iife' }),
]);

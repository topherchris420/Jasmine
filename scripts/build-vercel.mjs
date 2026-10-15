import { cp, mkdir, rm, stat } from 'node:fs/promises';

// No runtime dependencies are installed or bundled into the Vercel frontend.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await stat('dist/index.html');
await stat('api/index.mjs');
console.log('Built Jasmine Studio and the Vercel gateway. Runtime setup: docs/VERCEL.md');

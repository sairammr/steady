// Regenerates the SYNTHETIC fixtures in test/fixtures (seeded, byte-stable).
import fs from 'node:fs';
import { toJsonl } from '../src/core/recording.ts';
import { FIXTURES, synthesize } from '../src/core/synth.ts';

for (const [name, opts] of Object.entries(FIXTURES)) {
  const file = `test/fixtures/${name}.jsonl`;
  fs.writeFileSync(file, toJsonl(synthesize(opts).lines));
  console.log('wrote', file);
}

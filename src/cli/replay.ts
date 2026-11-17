// npm run replay -- <recording.jsonl> [--out session.json]
// Runs detector → sway check → scoring → report on a recording. No camera, no key.
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonl } from '../core/recording.ts';
import { formatReport, scoreRecording } from '../core/scoring.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: npm run replay -- <recording.jsonl> [--out session.json]');
  process.exit(2);
}
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const name = path.basename(file);
const { session, detail } = scoreRecording(parseJsonl(fs.readFileSync(file, 'utf8')), name);
console.log(formatReport(session, detail, `Replay: ${name}`));
if (out) {
  fs.writeFileSync(out, JSON.stringify(session, null, 2) + '\n');
  console.log(`session.json → ${out}`);
}

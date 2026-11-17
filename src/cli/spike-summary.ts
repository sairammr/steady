// npm run spike:summary -- <spike.jsonl>   (re-prints the D1 summary for a saved spike recording)
import fs from 'node:fs';
import { parseJsonl } from '../core/recording.ts';
import { formatSpike, summarizeSpike } from '../core/spike.ts';

const file = process.argv[2];
if (!file) { console.error('usage: npm run spike:summary -- <spike.jsonl>'); process.exit(2); }
const s = summarizeSpike(parseJsonl(fs.readFileSync(file, 'utf8')));
console.log(formatSpike(s));
console.log(JSON.stringify(s));

// Live SDK wrapper, following electron-quickstart/renderer.js: SDK built in the renderer,
// metrics decoded with decodeMetrics in the 'metrics' handler. Each event becomes one raw
// `m` line. Only numbers leave this module; the camera stream goes to a <video> for display only.
import { SmartSpectraSDK, ProcessingStatus, ValidationCode, breathingMetrics, cardioMetrics, faceMetrics } from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import type { Line, MLine, MarkLine, Sample } from '../core/recording.ts';

const toNum = (ts: unknown): number => {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  const l = ts as { toNumber?: () => number };
  return typeof l.toNumber === 'function' ? l.toNumber() : Number(ts);
};

const VALIDATION_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));
const STATUS_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));

const BUNDLES = [...breathingMetrics, ...cardioMetrics, ...faceMetrics];

export type LiveEvents = {
  onLine: (l: Line) => void;
  onStream?: (s: MediaStream) => void;
  onStatus?: (text: string) => void;
  onError?: (text: string) => void;
};

export class Live {
  sdk: SmartSpectraSDK | null = null;
  valid = false;
  running = false;
  hint = 'Starting camera…';
  talking = false;
  lastPulse: number | null = null;
  lastRate: number | null = null;
  lastArrival = 0;
  firstRawTs: string | null = null;
  private ev: LiveEvents;
  private key: string;
  constructor(key: string, ev: LiveEvents) { this.key = key; this.ev = ev; }

  private mark(name: string, detail?: string) {
    const l: MarkLine = { k: 'mark', name, t: Date.now(), ...(detail ? { detail } : {}) };
    this.ev.onLine(l);
  }

  private build(metrics: number[]) {
    const sdk = new SmartSpectraSDK({
      apiKey: this.key,
      requestedMetrics: metrics,
      enableTelemetry: false, // PRD §10; VERIFY D1 in SDK logs
      enableAccumulatedOutput: false,
    });
    sdk.on('processingStatus', (s: number) => {
      this.running = s === ProcessingStatus.kRunning;
      this.mark('status', STATUS_NAMES[s] ?? String(s));
      this.ev.onStatus?.(STATUS_NAMES[s] ?? String(s));
    });
    sdk.on('validationStatus', (code: number, _ts: number, hint: string) => {
      const ok = code === ValidationCode.kOk;
      if (ok !== this.valid || (!ok && hint !== this.hint)) this.mark('validation', `${VALIDATION_NAMES[code] ?? code}${hint ? ': ' + hint : ''}`);
      this.valid = ok;
      this.hint = ok ? '' : hint || VALIDATION_NAMES[code] || 'Adjust position';
    });
    sdk.on('metrics', (buf: Uint8Array) => {
      const t_arr = Date.now();
      let m: any;
      try { m = decodeMetrics(buf); } catch (e) { this.mark('decode_error', String(e)); return; }
      const trace: any[] = m.breathing?.upperTrace ?? [];
      if (trace.length && this.firstRawTs === null) {
        this.firstRawTs = String(trace[0].timestamp);
        this.mark('first_ts_raw', `${this.firstRawTs} at wall ${t_arr}`);
      }
      const upper: Sample[] = trace.map((x) => ({ t: toNum(x.timestamp) / 1000, v: x.value, s: !!x.stable }));
      const talk: any[] = m.face?.talking ?? [];
      if (talk.length) this.talking = talk.some((d) => d.detected);
      this.lastRate = m.breathing?.rate?.at(-1)?.value ?? this.lastRate;
      this.lastPulse = m.cardio?.pulseRate?.at(-1)?.value ?? this.lastPulse;
      this.lastArrival = t_arr;
      const line: MLine = {
        k: 'm', t_arr, upper,
        rate: m.breathing?.rate?.at(-1)?.value ?? null,
        pulse: m.cardio?.pulseRate?.at(-1)?.value ?? null,
        talking: this.talking, valid: this.valid && this.running,
      };
      this.ev.onLine(line);
    });
    sdk.on('error', (code: number, msg: string, retryable: boolean) => {
      this.mark('error', `${code}: ${msg}${retryable ? ' (retryable)' : ''}`);
      this.ev.onError?.(`${msg} (code ${code})`);
    });
    sdk.on('streamAvailable', (stream: MediaStream) => this.ev.onStream?.(stream));
    return sdk;
  }

  async start() {
    if (this.sdk) return;
    // D1 finding: the hand-picked list does not throw; the SDK stalls at Starting for 30 s
    // (error 8) with a 0x0 camera stream. The bundles (as in Presage's quickstart) are the
    // only verified-working config, so request them directly.
    this.sdk = this.build(BUNDLES);
    await this.sdk.start();
    this.mark('metrics_requested', 'bundles');
  }

  async stop() {
    const sdk = this.sdk;
    this.sdk = null;
    this.running = false;
    this.valid = false;
    if (!sdk) return;
    try { await sdk.stop(); } catch { /* already stopped */ }
    try { sdk.destroy(); } catch { /* already destroyed */ }
  }
}

/**
 * Tiny Prometheus-compatible metrics registry (zero-dependency). Exposes the
 * counters/gauges/histograms named in ARCHITECTURE §13 and renders the text
 * exposition format for /metrics. Swap for prom-client without touching callers.
 */
type Labels = Record<string, string>;

function key(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return `${name}{${parts.join(',')}}`;
}

export class Counter {
  private vals = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels?: Labels, by = 1) {
    const k = key(this.name, labels);
    this.vals.set(k, (this.vals.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.vals) lines.push(`${k} ${v}`);
    return lines.join('\n');
  }
}

export class Gauge {
  private vals = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(v: number, labels?: Labels) { this.vals.set(key(this.name, labels), v); }
  inc(by = 1, labels?: Labels) { const k = key(this.name, labels); this.vals.set(k, (this.vals.get(k) ?? 0) + by); }
  dec(by = 1, labels?: Labels) { this.inc(-by, labels); }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.vals) lines.push(`${k} ${v}`);
    return lines.join('\n');
  }
}

/** Fixed-bucket histogram (seconds). */
export class Histogram {
  private buckets: number[];
  private counts: number[];
  private sum = 0;
  private count = 0;
  constructor(readonly name: string, readonly help: string, buckets = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(v: number) {
    this.sum += v;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]) this.counts[i]++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative = this.counts[i];
      lines.push(`${this.name}_bucket{le="${this.buckets[i]}"} ${cumulative}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

export class Metrics {
  activeConnections = new Gauge('ingest_active_connections', 'Currently open device sockets');
  recordsTotal = new Counter('ingest_records_total', 'AVL records accepted');
  packetsTotal = new Counter('ingest_packets_total', 'AVL packets decoded, by transport');
  decodeErrors = new Counter('ingest_decode_errors_total', 'Decode/CRC/framing errors, by reason');
  rejectedImeis = new Counter('ingest_rejected_imeis_total', 'IMEI login rejections');
  duplicatesDropped = new Counter('ingest_duplicates_dropped_total', 'Records dropped by dedupe');
  ackLatency = new Histogram('ingest_ack_latency_seconds', 'Time from packet decoded to ack sent');
  downlinkSent = new Counter('ingest_downlink_commands_total', 'Codec 12 commands sent to devices');

  render(): string {
    return [
      this.activeConnections,
      this.recordsTotal,
      this.packetsTotal,
      this.decodeErrors,
      this.rejectedImeis,
      this.duplicatesDropped,
      this.ackLatency,
      this.downlinkSent,
    ]
      .map((m) => m.render())
      .join('\n\n');
  }
}

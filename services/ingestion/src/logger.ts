/**
 * Minimal structured (JSON-lines) logger. Zero-dependency so the service runs
 * anywhere; the interface matches pino closely, so swapping in pino later is a
 * one-file change. No PII/raw positions are logged by callers — only IMEI +
 * counts (see ARCHITECTURE §14).
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(opts?: {
  level?: Level;
  bindings?: Record<string, unknown>;
  sink?: (line: string) => void;
  now?: () => number;
}): Logger {
  const level = opts?.level ?? (process.env.LOG_LEVEL as Level) ?? 'info';
  const bindings = opts?.bindings ?? {};
  const sink = opts?.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts?.now ?? (() => Date.now());

  function log(lvl: Level, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(JSON.stringify({ ts: new Date(now()).toISOString(), level: lvl, msg, ...bindings, ...fields }));
  }
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink, now }),
  };
}

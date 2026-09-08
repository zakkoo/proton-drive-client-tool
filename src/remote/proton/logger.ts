import type { Logger } from '@protontech/drive-sdk';

import { redact } from '../../audit/redact.js';

export type { Logger };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogSink = (level: LogLevel, component: string, message: string, error?: unknown) => void;

/** Console sink with redaction applied to every message and error. */
export const consoleSink: LogSink = (level, component, message, error) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${component}: ${String(redact(message))}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(error === undefined ? `${line}\n` : `${line} ${JSON.stringify(redact(error))}\n`);
};

export const silentSink: LogSink = () => undefined;

/** Create a Logger for one component. Messages below `minLevel` are dropped. */
export function createLogger(component: string, sink: LogSink = consoleSink, minLevel: LogLevel = 'info'): Logger {
  const enabled = (level: LogLevel): boolean => ORDER[level] >= ORDER[minLevel];
  return {
    debug: (msg) => {
      if (enabled('debug')) sink('debug', component, msg);
    },
    info: (msg) => {
      if (enabled('info')) sink('info', component, msg);
    },
    warn: (msg) => {
      if (enabled('warn')) sink('warn', component, msg);
    },
    error: (msg, error) => {
      if (enabled('error')) sink('error', component, msg, error);
    },
  };
}

import type { EngineStatus } from '../engine/status.js';

export function print(json: boolean, human: string | string[], data: unknown): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const lines = Array.isArray(human) ? human : [human];
  process.stdout.write(lines.join('\n') + '\n');
}

export function formatStatus(status: EngineStatus): string[] {
  const lines = [...status.summaryLines];
  for (const t of status.transfers) {
    const pct = t.total !== undefined && t.total > 0 ? ` ${String(Math.round((t.bytes / t.total) * 100))}%` : '';
    lines.push(`  ${t.kind === 'upload' ? '^' : 'v'} ${t.relPath}${pct} (${formatBytes(t.speed)}/s)`);
  }
  return lines;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(Math.round(n))} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function formatTable(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

export function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

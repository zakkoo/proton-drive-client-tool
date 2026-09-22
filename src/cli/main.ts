/**
 * proton-drive-sync entry point: argument parsing and process wiring around
 * the command implementations in commands.ts.
 */
import { parseArgs } from 'node:util';

import type { LogLevel } from '../remote/proton/logger.js';
import { CliError, dispatch, type CommandDeps, type ParsedArgs } from './commands.js';
import { prompt } from './prompt.js';
import { createRuntime, loadContext } from './runtime.js';

export function parseCli(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean', default: false },
      'log-level': { type: 'string' },
      password: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      paused: { type: 'boolean', default: false },
      'no-tray': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  return {
    command,
    rest,
    json: values.json === true,
    password: values.password === true,
    dryRun: values['dry-run'] === true,
    paused: values.paused === true,
    tray: values['no-tray'] !== true,
    help: values.help === true,
    logLevel: typeof values['log-level'] === 'string' ? values['log-level'] : undefined,
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseCli(argv);
  const ctx = loadContext({ ...(args.logLevel !== undefined ? { logLevel: args.logLevel as LogLevel } : {}), quiet: args.json });
  const deps: CommandDeps = {
    ctx,
    createRuntime: (onThrottle) => createRuntime(ctx, onThrottle !== undefined ? { onThrottle } : {}),
    prompt,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    startTray: async ({ engine, controlTarget, detailUrl }) => {
      const mod = await import('../tray/index.js');
      if (ctx.config === null) throw new Error('not configured');
      return mod.startTray({
        engine: engine as never,
        controlTarget: controlTarget as never,
        detailUrl,
        config: ctx.config,
        paths: ctx.paths,
        audit: ctx.audit,
        logSink: ctx.logSink,
      });
    },
  };
  return dispatch(deps, args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

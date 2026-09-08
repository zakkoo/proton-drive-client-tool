/**
 * Builds the Proton runtime (secret store, HTTP, auth, SDK) from the
 * configuration and app paths.
 */
import { AuditLog } from '../audit/logger.js';
import { loadConfigFile } from '../config/configFile.js';
import { resolveAppPaths, type AppPaths } from '../config/paths.js';
import type { SyncConfig } from '../config/schema.js';
import { createSecretStore, type SecretStore } from '../config/secretStore.js';
import { consoleSink, type LogLevel, type LogSink } from '../remote/proton/logger.js';
import { createProtonDriveRuntime, type ProtonDriveRuntime } from '../remote/proton/bootstrap.js';

export interface CliContext {
  paths: AppPaths;
  config: SyncConfig | null;
  audit: AuditLog;
  logSink: LogSink;
  logLevel: LogLevel;
}

export function loadContext(options: { logLevel?: LogLevel; quiet?: boolean } = {}): CliContext {
  const paths = resolveAppPaths();
  const config = loadConfigFile(paths.configFile);
  const logLevel = options.logLevel ?? (process.env['PROTON_DRIVE_SYNC_LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
  const audit = new AuditLog({ dir: paths.auditLogDir, retentionDays: config?.safety.logRetentionDays ?? 90 });
  return { paths, config, audit, logSink: options.quiet === true ? () => undefined : consoleSink, logLevel };
}

export function secretStoreFor(ctx: CliContext): SecretStore {
  return createSecretStore({
    kind: ctx.config?.credentialsStore ?? 'keychain',
    acknowledgeUnsafe: ctx.config?.acknowledgeUnsafeCredentialsStore ?? false,
    dataDir: ctx.paths.dataDir,
  });
}

export async function createRuntime(ctx: CliContext, extra: { onThrottle?: (state: 'throttled' | 'unthrottled') => void; cursorStore?: { getLatestEventId(scopeId: string): Promise<string | null> } } = {}): Promise<ProtonDriveRuntime> {
  return createProtonDriveRuntime({
    paths: ctx.paths,
    secretStore: secretStoreFor(ctx),
    logSink: ctx.logSink,
    logLevel: ctx.logLevel,
    ...(extra.onThrottle !== undefined ? { onThrottle: extra.onThrottle } : {}),
    ...(extra.cursorStore !== undefined ? { cursorStore: extra.cursorStore } : {}),
  });
}

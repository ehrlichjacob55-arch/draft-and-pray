export const DDB_LOCAL_DIR: string;
export function resolveJava(): string;
export function ensureDynamoDbLocal(): Promise<string>;
export function getFreePort(): Promise<number>;
export function startDynamoDbLocal(opts?: {
  port?: number;
  inMemory?: boolean;
  dbPath?: string;
  timeoutMs?: number;
}): Promise<{ endpoint: string; stop: () => Promise<void> }>;

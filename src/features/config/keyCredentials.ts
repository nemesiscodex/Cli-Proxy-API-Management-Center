import type { KeyCredentialEntry } from '@/types/visualConfig';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeCredentialPatterns(patterns: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of patterns) {
    const pattern = typeof item === 'string' ? item.trim() : '';
    if (pattern) seen.add(pattern);
  }
  return [...seen];
}

/** Entries without a key are skipped; an entry with no credentials stays (it allows no accounts). */
export function parseKeyCredentials(raw: unknown): KeyCredentialEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: KeyCredentialEntry[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const key = typeof record?.key === 'string' ? record.key.trim() : '';
    if (!key) continue;
    const credentials = Array.isArray(record?.credentials) ? record.credentials : [];
    entries.push({ key, credentials: normalizeCredentialPatterns(credentials) });
  }
  return entries;
}

export function serializeKeyCredentialsForYaml(
  entries: KeyCredentialEntry[]
): Array<{ key: string; credentials: string[] }> {
  return entries
    .map((entry) => ({
      key: entry.key.trim(),
      credentials: normalizeCredentialPatterns(entry.credentials),
    }))
    .filter((entry) => entry.key);
}

export function areKeyCredentialsEqual(
  left: KeyCredentialEntry[],
  right: KeyCredentialEntry[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((a, i) => {
    const b = right[i];
    return (
      a.key === b.key &&
      a.credentials.length === b.credentials.length &&
      a.credentials.every((pattern, j) => pattern === b.credentials[j])
    );
  });
}

/** null means the key has no entry and may use every account. */
export function findKeyCredentials(entries: KeyCredentialEntry[], key: string): string[] | null {
  return entries.find((entry) => entry.key === key)?.credentials ?? null;
}

/**
 * Point `key` at `credentials` (null removes its entry). Entries for `previousKey` move to `key`,
 * keeping their position, so a rename does not reorder the YAML list.
 */
export function setKeyCredentials(
  entries: KeyCredentialEntry[],
  key: string,
  credentials: string[] | null,
  previousKey?: string
): KeyCredentialEntry[] {
  const matches = (entry: KeyCredentialEntry) =>
    entry.key === key || (previousKey !== undefined && entry.key === previousKey);
  const next: KeyCredentialEntry[] = [];
  let placed = false;
  for (const entry of entries) {
    if (!matches(entry)) {
      next.push(entry);
    } else if (!placed && credentials !== null) {
      next.push({ key, credentials });
      placed = true;
    }
  }
  if (!placed && credentials !== null) next.push({ key, credentials });
  return next;
}

export function dropKeyCredentials(
  entries: KeyCredentialEntry[],
  key: string
): KeyCredentialEntry[] {
  return entries.filter((entry) => entry.key !== key);
}

/** Split patterns into exact IDs of listed accounts and everything else (globs, unlisted IDs). */
export function splitCredentialPatterns(
  patterns: string[],
  accountIds: ReadonlySet<string>
): { selected: string[]; extra: string[] } {
  return {
    selected: patterns.filter((pattern) => accountIds.has(pattern)),
    extra: patterns.filter((pattern) => !accountIds.has(pattern)),
  };
}

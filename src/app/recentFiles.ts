/**
 * Recently opened projects and images, for the welcome screen.
 *
 * Paths only, kept in `localStorage` — a per-machine convenience, never read by
 * the core and never sent anywhere. Every access is wrapped: storage can throw
 * or come back empty (private windows, blocked site data), and the welcome
 * screen must still render without it.
 */

export type RecentKind = 'project' | 'image';

export interface RecentFile {
  readonly path: string;
  readonly kind: RecentKind;
  readonly at: number;
}

export const RECENT_KEY = 'tesserica.recent.v1';
export const MAX_RECENT = 8;

export function loadRecent(): RecentFile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentFile =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as RecentFile).path === 'string' &&
          ((r as RecentFile).kind === 'project' || (r as RecentFile).kind === 'image'),
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Newest first, de-duplicated by path, capped at {@link MAX_RECENT}. */
export function addRecent(path: string, kind: RecentKind, now: number = Date.now()): RecentFile[] {
  const next = [{ path, kind, at: now }, ...loadRecent().filter((r) => r.path !== path)].slice(
    0,
    MAX_RECENT,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the list simply will not persist */
  }
  return next;
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* nothing to do */
  }
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

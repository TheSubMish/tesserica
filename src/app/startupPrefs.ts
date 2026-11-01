/**
 * Per-machine startup preferences (welcome screen, first-run tips).
 * `localStorage` only, every access guarded — see `recentFiles.ts`.
 */

const WELCOME_KEY = 'tesserica.welcome.hide';
const TIPS_KEY = 'tesserica.tips.done';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* unavailable — the preference just will not persist */
  }
}

export const shouldShowWelcome = (): boolean => read(WELCOME_KEY) !== '1';
export const setShowWelcomeOnStartup = (show: boolean): void =>
  write(WELCOME_KEY, show ? null : '1');

export const tipsDone = (): boolean => read(TIPS_KEY) === '1';
export const markTipsDone = (): void => write(TIPS_KEY, '1');
export const resetTips = (): void => write(TIPS_KEY, null);

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards a contrast bug that is invisible to every other test we have and
 * obvious to every user.
 *
 * WebKit on Linux draws `<select>` as a native GTK widget which paints its own
 * background and ignores ours. On a light system theme that left our near-white
 * `--text` sitting on a pale native background — the Conversion, Layer and
 * Palette dropdowns all rendered with unreadable values.
 *
 * `appearance: none` is the single declaration that fixes it, and deleting it
 * would reintroduce the bug silently, because nothing else in the suite renders
 * a real widget. Hence this test: it asserts the *contract*, not the pixels.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'global.css'), 'utf8');

/** Declarations of the first rule whose selector list matches exactly. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!match) throw new Error(`no rule for selector "${selector}" in global.css`);
  return match[2];
}

describe('native form controls are themed by us, not by the platform', () => {
  it('takes select rendering away from the native widget', () => {
    const declarations = rule('select');
    // Without this the platform paints the background and our colours are moot.
    expect(declarations).toMatch(/(^|\s)appearance:\s*none/);
    expect(declarations).toMatch(/-webkit-appearance:\s*none/);
  });

  it('gives select an explicit background and foreground', () => {
    const declarations = rule('select');
    expect(declarations).toMatch(/background-color:\s*var\(--bg-elevated\)/);
    expect(declarations).toMatch(/(^|\s)color:\s*var\(--text\)/);
  });

  it('keeps an arrow, since appearance:none removes the native one', () => {
    // A select with no affordance is indistinguishable from a text box.
    expect(rule('select')).toMatch(/background-image:\s*url\(/);
  });

  it('themes the popup list as well as the closed control', () => {
    const declarations = rule('select option');
    expect(declarations).toMatch(/background-color:\s*var\(--bg-elevated\)/);
    expect(declarations).toMatch(/color:\s*var\(--text\)/);
  });

  it('lets sliders shrink so the value beside them is not clipped', () => {
    // Range inputs have a ~129px intrinsic width, and flex items do not shrink
    // below intrinsic size — which pushed value readouts out of the 220px rail.
    expect(rule(".field input[type='range']")).toMatch(/min-width:\s*0/);
  });
});

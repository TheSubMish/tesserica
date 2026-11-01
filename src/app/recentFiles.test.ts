import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_RECENT,
  RECENT_KEY,
  addRecent,
  clearRecent,
  fileName,
  loadRecent,
} from './recentFiles';

describe('recent files', () => {
  beforeEach(() => localStorage.clear());

  it('puts the newest first and de-duplicates by path', () => {
    addRecent('/a.tess', 'project', 1);
    addRecent('/b.png', 'image', 2);
    addRecent('/a.tess', 'project', 3);
    expect(loadRecent().map((r) => r.path)).toEqual(['/a.tess', '/b.png']);
  });

  it('caps the list', () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) addRecent(`/f${i}.png`, 'image', i);
    expect(loadRecent()).toHaveLength(MAX_RECENT);
    expect(loadRecent()[0].path).toBe(`/f${MAX_RECENT + 4}.png`);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem(RECENT_KEY, '{not json');
    expect(loadRecent()).toEqual([]);
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([{ path: 1 }, { path: '/ok', kind: 'image', at: 1 }]),
    );
    expect(loadRecent().map((r) => r.path)).toEqual(['/ok']);
  });

  it('clears and names files', () => {
    addRecent('/x/y/z.tess', 'project');
    clearRecent();
    expect(loadRecent()).toEqual([]);
    expect(fileName('/x/y/z.tess')).toBe('z.tess');
    expect(fileName('C:\\x\\z.tess')).toBe('z.tess');
  });
});

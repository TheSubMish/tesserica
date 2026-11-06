import { describe, expect, it, vi } from 'vitest';

import { buildCommands, filterCommands, fuzzyScore, type AppActions } from './commands';

const noop = () => {};
const actions: AppActions = {
  newSprite: noop,
  openProject: noop,
  saveProject: noop,
  saveProjectAs: noop,
  openImage: noop,
  openSample: noop,
  exportImage: noop,
  batchConvert: noop,
  convertFormat: noop,
  showWelcome: noop,
  showShortcuts: noop,
  canvasSize: noop,
  spriteOp: noop,
};

describe('fuzzyScore', () => {
  it('requires the characters in order', () => {
    expect(fuzzyScore('pcl', 'Pencil tool')).toBeGreaterThan(-1);
    expect(fuzzyScore('clp', 'Pencil tool')).toBe(-1);
  });

  it('ranks a prefix above a scattered match', () => {
    expect(fuzzyScore('pen', 'Pencil tool')).toBeGreaterThan(fuzzyScore('pen', 'Open project'));
  });

  it('matches everything on an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});

describe('command registry', () => {
  const commands = buildCommands(actions);

  it('has unique ids', () => {
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
  });

  it('finds a command by a loose query, best match first', () => {
    expect(filterCommands(commands, 'grid')[0].id).toBe('view.grid');
    expect(filterCommands(commands, 'ellip')[0].id).toBe('tool.ellipse');
    expect(filterCommands(commands, 'zzzzqq')).toEqual([]);
  });

  it('offers every sprite operation, wired to its own run', () => {
    const spriteOp = vi.fn();
    const cmds = buildCommands({ ...actions, spriteOp });
    expect(cmds.filter((c) => c.group === 'Sprite').length).toBeGreaterThanOrEqual(10);
    cmds.find((c) => c.id === 'sprite.flatten')?.run();
    expect(spriteOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'flatten' }));
  });

  it('runs injected app actions', () => {
    const newSprite = vi.fn();
    buildCommands({ ...actions, newSprite })
      .find((c) => c.id === 'file.new')
      ?.run();
    expect(newSprite).toHaveBeenCalledOnce();
  });
});

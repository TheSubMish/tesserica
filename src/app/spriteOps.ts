/**
 * The whole-document operations as one table, so the Sprite menu, the command
 * palette and any future shortcut all offer exactly the same list and run the
 * same code (`docs/03-data-model.md` §6.1).
 */

import { flattenLayers, mergeDown } from '../history/mergeCommands';
import {
  cropToSelection,
  flipActiveLayer,
  transformSprite,
  type SpriteOpResult,
} from '../history/spriteCommands';

export interface SpriteOp {
  readonly id: string;
  readonly label: string;
  readonly run: () => SpriteOpResult;
}

export const SPRITE_OPS: readonly SpriteOp[] = [
  { id: 'crop', label: 'Crop to Selection', run: cropToSelection },
  { id: 'flip-h', label: 'Flip Sprite Horizontally', run: () => transformSprite('flip-h') },
  { id: 'flip-v', label: 'Flip Sprite Vertically', run: () => transformSprite('flip-v') },
  { id: 'rot-cw', label: 'Rotate Sprite 90° Clockwise', run: () => transformSprite('rot-cw') },
  {
    id: 'rot-ccw',
    label: 'Rotate Sprite 90° Counter-clockwise',
    run: () => transformSprite('rot-ccw'),
  },
  { id: 'rot-180', label: 'Rotate Sprite 180°', run: () => transformSprite('rot-180') },
  { id: 'layer-flip-h', label: 'Flip Layer Horizontally', run: () => flipActiveLayer('h') },
  { id: 'layer-flip-v', label: 'Flip Layer Vertically', run: () => flipActiveLayer('v') },
  { id: 'merge-down', label: 'Merge Layer Down', run: mergeDown },
  { id: 'flatten', label: 'Flatten Layers', run: flattenLayers },
];

export function findSpriteOp(id: string): SpriteOp | undefined {
  return SPRITE_OPS.find((o) => o.id === id);
}

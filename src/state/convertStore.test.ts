import { beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_PALETTES } from '../lib/palettes/builtin';
import {
  MAX_PIXEL_SIZE,
  MIN_PIXEL_SIZE,
  buildSettings,
  paletteColors,
  targetSize,
  useConvertStore,
} from './convertStore';

const INITIAL = useConvertStore.getState();

function withSource(width = 4000, height = 3000) {
  useConvertStore.getState().setSource({
    sourceId: 1,
    width,
    height,
    path: '/tmp/photo.jpg',
    isProxy: true,
  });
}

describe('convertStore', () => {
  beforeEach(() => {
    useConvertStore.setState(INITIAL, true);
  });

  it('derives output dimensions from pixel size, not the other way round', () => {
    withSource(4000, 3000);
    useConvertStore.getState().setPixelSize(50);
    expect(targetSize(useConvertStore.getState())).toEqual({ width: 80, height: 60 });
  });

  it('reports no output size before an image is open', () => {
    expect(targetSize(useConvertStore.getState())).toEqual({ width: 0, height: 0 });
  });

  it('clamps pixel size to a usable range', () => {
    const s = useConvertStore.getState();
    s.setPixelSize(0);
    expect(useConvertStore.getState().pixelSize).toBe(MIN_PIXEL_SIZE);
    s.setPixelSize(9999);
    expect(useConvertStore.getState().pixelSize).toBe(MAX_PIXEL_SIZE);
  });

  it('clamps dither strength and the split position to 0..1', () => {
    const s = useConvertStore.getState();
    s.setDitherStrength(5);
    expect(useConvertStore.getState().ditherStrength).toBe(1);
    s.setDitherStrength(-2);
    expect(useConvertStore.getState().ditherStrength).toBe(0);
    s.setSplitAt(1.4);
    expect(useConvertStore.getState().splitAt).toBe(1);
    s.setSplitAt(-0.4);
    expect(useConvertStore.getState().splitAt).toBe(0);
  });

  it('clears the previous preview and error when the source changes', () => {
    const s = useConvertStore.getState();
    s.setPreview({ width: 8, height: 8, colorsUsed: 3, elapsedMs: 1 });
    s.setError('boom');
    withSource();
    expect(useConvertStore.getState().preview).toBeUndefined();
    expect(useConvertStore.getState().error).toBeUndefined();
  });

  it('falls back to a bundled palette rather than throwing on an unknown id', () => {
    expect(paletteColors('does-not-exist')).toEqual(BUILTIN_PALETTES[0].colors);
  });

  describe('buildSettings', () => {
    it('translates the UI vocabulary into the pipeline parameter struct', () => {
      withSource(800, 600);
      const s = useConvertStore.getState();
      s.setPixelSize(10);
      s.setPaletteId(BUILTIN_PALETTES[1].id);
      s.setDither('atkinson');
      s.setDitherStrength(0.5);
      s.setAdvanced({ downscaleMode: 'nearest', brightness: 0.25, despeckle: 2 });

      const settings = buildSettings(useConvertStore.getState());

      expect(settings.targetWidth).toBe(80);
      expect(settings.targetHeight).toBe(60);
      expect(settings.dither).toBe('atkinson');
      expect(settings.ditherStrength).toBe(0.5);
      expect(settings.downscaleMode).toBe('nearest');
      expect(settings.brightness).toBe(0.25);
      expect(settings.despeckle).toBe(2);
      expect(settings.palette).toEqual({
        kind: 'fixed',
        colors: BUILTIN_PALETTES[1].colors,
      });
    });

    it('never asks the pipeline for a zero-sized output', () => {
      // No source: the pipeline would reject 0×0, so the floor of 1 matters.
      const settings = buildSettings(useConvertStore.getState());
      expect(settings.targetWidth).toBeGreaterThanOrEqual(1);
      expect(settings.targetHeight).toBeGreaterThanOrEqual(1);
    });

    it('defaults to Oklab colour distance', () => {
      withSource();
      expect(buildSettings(useConvertStore.getState()).colorSpace).toBe('oklab');
    });

    it('omits background removal from the pipeline settings until enabled', () => {
      withSource();
      expect(buildSettings(useConvertStore.getState()).backgroundRemoval).toBeUndefined();
    });

    it('turns the toggle and tolerance into a BackgroundRemovalSettings', () => {
      withSource();
      useConvertStore.getState().setAdvanced({
        backgroundRemovalEnabled: true,
        backgroundRemovalTolerance: 0.12,
      });
      expect(buildSettings(useConvertStore.getState()).backgroundRemoval).toEqual({
        tolerance: 0.12,
      });
    });

    it('omits mask post-processing fields while they are at their off defaults', () => {
      withSource();
      useConvertStore.getState().setAdvanced({ backgroundRemovalEnabled: true });
      expect(buildSettings(useConvertStore.getState()).backgroundRemoval).toEqual({
        tolerance: 0.08,
      });
    });

    it('includes threshold only once the re-threshold checkbox is on', () => {
      withSource();
      useConvertStore.getState().setAdvanced({
        backgroundRemovalEnabled: true,
        maskThreshold: 200,
      });
      expect(
        buildSettings(useConvertStore.getState()).backgroundRemoval?.threshold,
      ).toBeUndefined();

      useConvertStore.getState().setAdvanced({ maskThresholdEnabled: true });
      expect(buildSettings(useConvertStore.getState()).backgroundRemoval?.threshold).toBe(200);
    });

    it('includes close and feather once either radius is above zero', () => {
      withSource();
      useConvertStore.getState().setAdvanced({
        backgroundRemovalEnabled: true,
        maskClose: 3,
        maskFeather: 5,
      });
      expect(buildSettings(useConvertStore.getState()).backgroundRemoval).toEqual({
        tolerance: 0.08,
        close: 3,
        feather: 5,
      });
    });
  });
});

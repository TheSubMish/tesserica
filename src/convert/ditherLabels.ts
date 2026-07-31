/**
 * Display labels for `DitherMode` (`docs/04-image-pipeline.md` §5).
 *
 * Split out of `ConvertPanel.tsx` so it can be shared with
 * `app/BatchConvertDialog.tsx` (`docs/08-roadmap.md` Phase 7 "Batch
 * conversion") without re-declaring the same dropdown twice, and so the
 * component file only exports a component (`react-refresh/only-export-
 * components`).
 */

import type { DitherMode } from '../pipeline/settings.ts';

export const DITHER_LABELS: ReadonlyArray<{ value: DitherMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'floyd-steinberg', label: 'Floyd–Steinberg' },
  { value: 'atkinson', label: 'Atkinson' },
  { value: 'bayer2', label: 'Bayer 2×2' },
  { value: 'bayer4', label: 'Bayer 4×4' },
  { value: 'bayer8', label: 'Bayer 8×8' },
];

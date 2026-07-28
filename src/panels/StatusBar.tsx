import { targetSize, useConvertStore } from '../state/convertStore';
import { useDocumentStore } from '../state/documentStore';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';

export function StatusBar() {
  const mode = useUIStore((s) => s.mode);
  if (mode === 'convert') return <ConvertStatusBar />;
  return <EditStatusBar />;
}

/**
 * Convert mode's status line (`docs/05-ui-design.md` §3).
 *
 * It **states when the preview is a proxy** — that is a requirement, not a
 * nicety (`docs/02-architecture.md` §3.3, mitigation 4): the preview is
 * approximate at proxy resolution under error diffusion, and the user is
 * entitled to know before they judge it.
 */
function ConvertStatusBar() {
  const source = useConvertStore((s) => s.source);
  const preview = useConvertStore((s) => s.preview);
  const busy = useConvertStore((s) => s.busy);
  const paletteId = useConvertStore((s) => s.paletteId);
  const target = targetSize(useConvertStore.getState());

  if (!source) {
    return (
      <footer className="statusbar">
        <span>No image</span>
      </footer>
    );
  }

  const name = source.path.split('/').pop() ?? source.path;

  return (
    <footer className="statusbar">
      <span>
        {name} {source.width}×{source.height} → {target.width}×{target.height}
      </span>
      <span className="sep">·</span>
      <span>{paletteId}</span>
      {preview && (
        <>
          <span className="sep">·</span>
          <span>{preview.colorsUsed} colours</span>
          <span className="sep">·</span>
          <span>{preview.elapsedMs.toFixed(1)} ms</span>
        </>
      )}
      <span className="sep">·</span>
      <span>{busy ? 'converting…' : source.isProxy ? 'preview (proxy)' : 'preview'}</span>
    </footer>
  );
}

function EditStatusBar() {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const layerName = sprite.layers.find((l) => l.id === activeLayerId)?.name ?? '—';

  const palettes = usePaletteStore((s) => s.palettes);
  const activePaletteId = usePaletteStore((s) => s.activePaletteId);
  const palette = palettes.find((p) => p.id === activePaletteId);

  const zoom = useUIStore((s) => s.zoom);
  const cursor = useUIStore((s) => s.cursor);
  const tool = useToolStore((s) => s.activeTool);
  const brushSize = useToolStore((s) => s.brushSize);

  return (
    <footer className="statusbar">
      <span>
        {sprite.width}×{sprite.height}
      </span>
      <span className="sep">·</span>
      <span>
        {tool} {brushSize}px
      </span>
      <span className="sep">·</span>
      <span>{palette ? `${palette.name} (${palette.colors.length})` : '—'}</span>
      <span className="sep">·</span>
      <span>{layerName}</span>
      <span className="sep">·</span>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        className="statusbar-btn"
        title="Center view on the picture (Home)"
        aria-label="Center view on the picture"
        onClick={() => useUIStore.getState().requestFit()}
      >
        ⌖
      </button>
      <span className="sep">·</span>
      <span>{cursor ? `x:${cursor.x} y:${cursor.y}` : 'x:— y:—'}</span>
    </footer>
  );
}

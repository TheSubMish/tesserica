import { useDocumentStore } from '../state/documentStore';
import { usePaletteStore } from '../state/paletteStore';
import { useToolStore } from '../state/toolStore';
import { useUIStore } from '../state/uiStore';

export function StatusBar() {
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
      <span className="sep">·</span>
      <span>{cursor ? `x:${cursor.x} y:${cursor.y}` : 'x:— y:—'}</span>
    </footer>
  );
}

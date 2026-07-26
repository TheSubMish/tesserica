import { useDocumentStore } from '../state/documentStore';
import { useUIStore } from '../state/uiStore';

export function StatusBar() {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const layerName = sprite.layers.find((l) => l.id === activeLayerId)?.name ?? '—';

  const zoom = useUIStore((s) => s.zoom);
  const cursor = useUIStore((s) => s.cursor);

  return (
    <footer className="statusbar">
      <span>
        {sprite.width}×{sprite.height}
      </span>
      <span className="sep">·</span>
      <span>{layerName}</span>
      <span className="sep">·</span>
      <span>{Math.round(zoom * 100)}%</span>
      <span className="sep">·</span>
      <span>{cursor ? `x:${cursor.x} y:${cursor.y}` : 'x:— y:—'}</span>
    </footer>
  );
}

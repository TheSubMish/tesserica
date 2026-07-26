import { useDocumentStore } from '../state/documentStore';
import { useToolStore } from '../state/toolStore';

export function LayerPanel() {
  const layers = useDocumentStore((s) => s.sprite.layers);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const brushSize = useToolStore((s) => s.brushSize);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <span>Layers</span>
          <span>
            <button
              title="Add layer"
              aria-label="Add layer"
              onClick={() => useDocumentStore.getState().addLayer()}
            >
              +
            </button>
            <button
              title="Delete layer"
              aria-label="Delete layer"
              onClick={() => useDocumentStore.getState().removeLayer(activeLayerId)}
            >
              🗑
            </button>
          </span>
        </div>

        <div className="layer-list" role="listbox" aria-label="Layers">
          {/* Top layer first, matching how every editor displays a stack. */}
          {[...layers].reverse().map((l) => (
            <div
              key={l.id}
              className="layer-row"
              role="option"
              tabIndex={0}
              aria-selected={l.id === activeLayerId}
              onClick={() => useDocumentStore.getState().setActiveLayer(l.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  useDocumentStore.getState().setActiveLayer(l.id);
                  e.preventDefault();
                }
              }}
            >
              {/* Visibility is an icon, never colour alone (docs/05-ui-design.md §8). */}
              <button
                className="layer-vis"
                aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                title={l.visible ? 'Hide' : 'Show'}
                onClick={(e) => {
                  e.stopPropagation();
                  useDocumentStore.getState().toggleLayerVisibility(l.id);
                }}
              >
                {l.visible ? '◉' : '○'}
              </button>
              <span className="layer-name">{l.name}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span>Brush</span>
        </div>
        <label className="field">
          Size
          <input
            type="range"
            min={1}
            max={16}
            value={brushSize}
            onChange={(e) => useToolStore.getState().setBrushSize(Number(e.target.value))}
          />
          <span className="value">{brushSize}</span>
        </label>
      </section>
    </>
  );
}

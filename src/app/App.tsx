import { CanvasView } from '../canvas/CanvasView';
import { LayerPanel } from '../panels/LayerPanel';
import { StatusBar } from '../panels/StatusBar';
import { useUIStore } from '../state/uiStore';

export function App() {
  const mode = useUIStore((s) => s.mode);

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">Tesserica</span>
        {/* Two modes, not three — D6/D7. Convert lands in Phase 2, so both
            tabs are inert for now (docs/08-roadmap.md Phase 0). */}
        <div className="modes" role="tablist" aria-label="Mode">
          <button
            className="mode-tab"
            role="tab"
            aria-selected={mode === 'convert'}
            disabled
            title="Convert mode arrives in Phase 2"
          >
            Convert
          </button>
          <button
            className="mode-tab"
            role="tab"
            aria-selected={mode === 'edit'}
            onClick={() => useUIStore.getState().setMode('edit')}
          >
            Edit
          </button>
        </div>
      </header>

      <div className="body">
        <CanvasView />
        <aside className="panels">
          <LayerPanel />
        </aside>
      </div>

      <StatusBar />
    </div>
  );
}

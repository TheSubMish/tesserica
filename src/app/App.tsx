import { useState } from 'react';
import { CanvasView } from '../canvas/CanvasView';
import { ConversionPanel } from '../panels/ConversionPanel';
import { LayerPanel } from '../panels/LayerPanel';
import { PalettePanel } from '../panels/PalettePanel';
import { StatusBar } from '../panels/StatusBar';
import { ToolOptions } from '../panels/ToolOptions';
import { ToolRail } from '../panels/ToolRail';
import { ConvertMode } from '../convert/ConvertMode';
import { handoffToEdit } from '../convert/editHandoff';
import { loadSourceImage } from '../convert/loadSource';
import { useUIStore } from '../state/uiStore';
import { ExportDialog } from './ExportDialog';
import { FileMenu } from './FileMenu';
import { openProject, pickImage, saveCurrentProject } from './project';
import { useShortcuts } from './shortcuts';

export function App() {
  const mode = useUIStore((s) => s.mode);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useShortcuts();

  const guard = async (label: string, run: () => Promise<string | null>) => {
    try {
      const path = await run();
      setNotice(path ? { text: `${label} ${path}`, error: false } : null);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <div className="app">
      <header className="titlebar">
        <FileMenu
          items={[
            {
              label: 'Open…',
              shortcut: 'Ctrl+O',
              onSelect: () =>
                void guard('Opened', async () => {
                  const result = await openProject();
                  if (result?.warnings.length) {
                    setNotice({ text: result.warnings.join('; '), error: true });
                    return null;
                  }
                  return result?.path ?? null;
                }),
            },
            {
              label: 'Save',
              shortcut: 'Ctrl+S',
              onSelect: () => void guard('Saved', () => saveCurrentProject({ saveAs: false })),
            },
            {
              label: 'Save As…',
              shortcut: 'Ctrl+Shift+S',
              onSelect: () => void guard('Saved', () => saveCurrentProject({ saveAs: true })),
            },
            {
              label: 'Open image…',
              onSelect: () =>
                void guard('Opened', async () => {
                  const path = await pickImage();
                  if (!path) return null;
                  useUIStore.getState().setMode('convert');
                  await loadSourceImage(path);
                  return path;
                }),
            },
            { label: 'Export PNG…', onSelect: () => setExporting(true) },
          ]}
        />
        <span className="wordmark">Tesserica</span>
        {/* Two modes, not three — D6/D7. */}
        <div className="modes" role="tablist" aria-label="Mode">
          <button
            className="mode-tab"
            role="tab"
            aria-selected={mode === 'convert'}
            onClick={() => useUIStore.getState().setMode('convert')}
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
        {mode === 'convert' ? (
          <ConvertMode
            onExport={() => setExporting(true)}
            onEdit={() => {
              try {
                const { width, height } = handoffToEdit();
                setNotice({ text: `Editing a ${width}×${height} conversion layer`, error: false });
              } catch (e) {
                setNotice({ text: e instanceof Error ? e.message : String(e), error: true });
              }
            }}
            onNotice={(text, error) => setNotice({ text, error })}
          />
        ) : (
          <>
            <ToolRail />
            <CanvasView />
            <aside className="panels">
              <ToolOptions />
              <ConversionPanel />
              <LayerPanel />
              <PalettePanel />
            </aside>
          </>
        )}
      </div>

      <StatusBar />

      {notice && (
        <div
          className={notice.error ? 'toast error' : 'toast'}
          role={notice.error ? 'alert' : 'status'}
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      )}

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  );
}

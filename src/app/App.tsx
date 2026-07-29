import { useEffect, useState } from 'react';
import { CanvasView } from '../canvas/CanvasView';
import { ConversionPanel } from '../panels/ConversionPanel';
import { LayerPanel } from '../panels/LayerPanel';
import { PalettePanel } from '../panels/PalettePanel';
import { StatusBar } from '../panels/StatusBar';
import { TimelinePanel } from '../panels/TimelinePanel';
import { ToolOptions } from '../panels/ToolOptions';
import { ToolRail } from '../panels/ToolRail';
import { ConvertMode } from '../convert/ConvertMode';
import { listenForImageDrop, SUPPORTED_IMAGE_EXTENSIONS } from '../convert/dropTarget';
import { handoffToEdit } from '../convert/editHandoff';
import { loadSourceImage } from '../convert/loadSource';
import { useUIStore } from '../state/uiStore';
import { ExportDialog } from './ExportDialog';
import { FileMenu } from './FileMenu';
import { NewSpriteDialog } from './NewSpriteDialog';
import { openProject, pickImage, saveCurrentProject } from './project';
import { useShortcuts } from './shortcuts';

export function App() {
  const mode = useUIStore((s) => s.mode);
  const showTimeline = useUIStore((s) => s.showTimeline);
  const [exporting, setExporting] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
  useShortcuts({ onNewSprite: () => setCreatingNew(true) });

  const guard = async (label: string, run: () => Promise<string | null>) => {
    try {
      const path = await run();
      setNotice(path ? { text: `${label} ${path}`, error: false } : null);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  /**
   * Whole-window drop target (`docs/05-ui-design.md` §3).
   *
   * Registered once for the app rather than on the Convert canvas: §3 asks for
   * the entire window, and a user dropping a photo while looking at the editor
   * means the same thing as dropping it on the converter.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listenForImageDrop({
      onDragOver: () => setDropping(true),
      onDragLeave: () => setDropping(false),
      onDrop: (path) => {
        void guard('Opened', async () => {
          useUIStore.getState().setMode('convert');
          await loadSourceImage(path);
          return path;
        });
      },
      onUnsupported: (paths) =>
        setNotice({
          text:
            `Cannot open ${paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files`}` +
            ` — Tesserica reads ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
          error: true,
        }),
    }).then((fn) => {
      // The listener resolves asynchronously, so a fast unmount can beat it.
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className={dropping ? 'app dropping' : 'app'}>
      <header className="titlebar">
        <FileMenu
          items={[
            {
              label: 'New…',
              shortcut: 'Ctrl+N',
              onSelect: () => setCreatingNew(true),
            },
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
        {/* Timeline is a panel inside Edit, not a mode (D7) — its toggle lives
            here rather than a View menu, which does not exist anywhere else
            in the app yet (`docs/05-ui-design.md` §5 allows either). */}
        {mode === 'edit' && (
          <button
            className="statusbar-btn"
            title="Toggle Timeline panel (T)"
            aria-label="Toggle Timeline panel"
            aria-pressed={showTimeline}
            onClick={() => useUIStore.getState().toggleTimeline()}
          >
            ▤
          </button>
        )}
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

      {mode === 'edit' && showTimeline && <TimelinePanel />}

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

      {dropping && (
        <div className="drop-overlay" role="status">
          <p>Drop an image to convert</p>
        </div>
      )}

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {creatingNew && <NewSpriteDialog onClose={() => setCreatingNew(false)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { CanvasView } from '../canvas/CanvasView';
import { ConversionPanel } from '../panels/ConversionPanel';
import { LayerPanel } from '../panels/LayerPanel';
import { PalettePanel } from '../panels/PalettePanel';
import { StatusBar } from '../panels/StatusBar';
import { TilesetPanel } from '../panels/TilesetPanel';
import { TimelinePanel } from '../panels/TimelinePanel';
import { ToolOptions } from '../panels/ToolOptions';
import { ToolRail } from '../panels/ToolRail';
import { ConvertMode } from '../convert/ConvertMode';
import { listenForImageDrop, SUPPORTED_IMAGE_EXTENSIONS } from '../convert/dropTarget';
import { handoffToEdit } from '../convert/editHandoff';
import { loadSampleImage, loadSourceImage } from '../convert/loadSource';
import { useUIStore } from '../state/uiStore';
import { Icon, LogoMark } from '../ui/icons';
import { BatchConvertDialog } from './BatchConvertDialog';
import { buildCommands, type AppActions } from './commands';
import { CommandPalette } from './CommandPalette';
import { ConvertFormatDialog } from './ConvertFormatDialog';
import { ExportDialog } from './ExportDialog';
import { FileMenu } from './FileMenu';
import { FirstRunTips } from './FirstRunTips';
import { NewSpriteDialog } from './NewSpriteDialog';
import {
  importAseFile,
  openProject,
  openProjectAt,
  pickImage,
  saveCurrentProject,
} from './project';
import { addRecent, clearRecent, loadRecent, type RecentFile } from './recentFiles';
import { ShortcutSheet } from './ShortcutSheet';
import { useShortcuts } from './shortcuts';
import { shouldShowWelcome } from './startupPrefs';
import { WelcomeScreen } from './WelcomeScreen';

export function App() {
  const mode = useUIStore((s) => s.mode);
  const showTimeline = useUIStore((s) => s.showTimeline);
  const [exporting, setExporting] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [batchConverting, setBatchConverting] = useState(false);
  const [convertingFormat, setConvertingFormat] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [welcome, setWelcome] = useState(shouldShowWelcome);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [recent, setRecent] = useState<RecentFile[]>(loadRecent);
  useShortcuts({
    onNewSprite: () => setCreatingNew(true),
    onCommandPalette: () => setPalette((open) => !open),
    onShortcutSheet: () => setShortcuts(true),
  });

  const guard = async (label: string, run: () => Promise<string | null>) => {
    try {
      const path = await run();
      setNotice(path ? { text: `${label} ${path}`, error: false } : null);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const remember = (path: string, kind: RecentFile['kind']): void =>
    setRecent(addRecent(path, kind));

  const openPhoto = (): void =>
    void guard('Opened', async () => {
      const path = await pickImage();
      if (!path) return null;
      useUIStore.getState().setMode('convert');
      await loadSourceImage(path);
      remember(path, 'image');
      return path;
    });

  const openSample = (): void =>
    void guard('Loaded', async () => {
      useUIStore.getState().setMode('convert');
      await loadSampleImage();
      return 'the sample photo';
    });

  const openProjectDialog = (): void =>
    void guard('Opened', async () => {
      const result = await openProject();
      if (result?.warnings.length) {
        setNotice({ text: result.warnings.join('; '), error: true });
        return null;
      }
      if (result) remember(result.path, 'project');
      return result?.path ?? null;
    });

  const save = (saveAs: boolean): void =>
    void guard('Saved', async () => {
      const path = await saveCurrentProject({ saveAs });
      if (path) remember(path, 'project');
      return path;
    });

  const openRecent = (file: RecentFile): void => {
    setWelcome(false);
    void guard('Opened', async () => {
      if (file.kind === 'image') {
        useUIStore.getState().setMode('convert');
        await loadSourceImage(file.path);
        remember(file.path, 'image');
        return file.path;
      }
      const result = await openProjectAt(file.path);
      if (result.warnings.length) {
        setNotice({ text: result.warnings.join('; '), error: true });
        return null;
      }
      remember(result.path, 'project');
      return result.path;
    });
  };

  const actions: AppActions = {
    newSprite: () => setCreatingNew(true),
    openProject: openProjectDialog,
    saveProject: () => save(false),
    saveProjectAs: () => save(true),
    openImage: openPhoto,
    openSample,
    exportImage: () => setExporting(true),
    batchConvert: () => setBatchConverting(true),
    convertFormat: () => setConvertingFormat(true),
    showWelcome: () => setWelcome(true),
    showShortcuts: () => setShortcuts(true),
  };
  const commands = buildCommands(actions);

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
          remember(path, 'image');
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
              onSelect: openProjectDialog,
            },
            {
              label: 'Import Aseprite file…',
              onSelect: () =>
                void guard('Imported', async () => {
                  const result = await importAseFile();
                  if (result?.warnings.length) {
                    setNotice({ text: result.warnings.join('; '), error: true });
                    return null;
                  }
                  return result?.path ?? null;
                }),
            },
            { label: 'Save', shortcut: 'Ctrl+S', onSelect: () => save(false) },
            { label: 'Save As…', shortcut: 'Ctrl+Shift+S', onSelect: () => save(true) },
            { label: 'Open image…', onSelect: openPhoto },
            { label: 'Export…', onSelect: () => setExporting(true) },
            { label: 'Batch Convert…', onSelect: () => setBatchConverting(true) },
            { label: 'Convert Image Format…', onSelect: () => setConvertingFormat(true) },
            { label: 'Command Palette…', shortcut: 'Ctrl+K', onSelect: () => setPalette(true) },
            { label: 'Keyboard Shortcuts', shortcut: '?', onSelect: () => setShortcuts(true) },
            { label: 'Welcome Screen', onSelect: () => setWelcome(true) },
          ]}
        />
        <span className="wordmark">
          <LogoMark size={18} />
          Tesserica
        </span>
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
            <Icon name="timeline" />
          </button>
        )}
      </header>

      <div className={mode === 'edit' ? 'body edit' : 'body'}>
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
            onOpenPhoto={openPhoto}
            onOpenSample={openSample}
          />
        ) : (
          <>
            <ToolRail />
            <aside className="palette-dock" aria-label="Palette">
              <PalettePanel docked />
            </aside>
            <div className="edit-center">
              <ToolOptions />
              <CanvasView />
            </div>
            <aside className="panels">
              <ConversionPanel />
              <LayerPanel />
              <TilesetPanel />
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

      {welcome && (
        <WelcomeScreen
          recent={recent}
          onClose={() => setWelcome(false)}
          onConvertPhoto={() => {
            setWelcome(false);
            useUIStore.getState().setMode('convert');
            openPhoto();
          }}
          onTrySample={() => {
            setWelcome(false);
            openSample();
          }}
          onNewSprite={() => {
            setWelcome(false);
            setCreatingNew(true);
          }}
          onOpenProject={() => {
            setWelcome(false);
            openProjectDialog();
          }}
          onOpenRecent={openRecent}
          onClearRecent={() => {
            clearRecent();
            setRecent([]);
          }}
        />
      )}
      {!welcome && <FirstRunTips />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {shortcuts && <ShortcutSheet commands={commands} onClose={() => setShortcuts(false)} />}

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {creatingNew && <NewSpriteDialog onClose={() => setCreatingNew(false)} />}
      {batchConverting && <BatchConvertDialog onClose={() => setBatchConverting(false)} />}
      {convertingFormat && <ConvertFormatDialog onClose={() => setConvertingFormat(false)} />}
    </div>
  );
}

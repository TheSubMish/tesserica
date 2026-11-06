import { useRef, useState } from 'react';

import { Icon, LogoMark, type IconName } from '../ui/icons';
import { fileName, type RecentFile } from './recentFiles';
import { setShowWelcomeOnStartup, shouldShowWelcome } from './startupPrefs';
import { useModalFocusTrap } from './useModalFocusTrap';

export interface WelcomeScreenProps {
  readonly recent: readonly RecentFile[];
  readonly onConvertPhoto: () => void;
  readonly onTrySample: () => void;
  readonly onNewSprite: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenRecent: (file: RecentFile) => void;
  readonly onClearRecent: () => void;
  readonly onClose: () => void;
}

/**
 * First thing a new user sees. Three ways in — the product's own two halves
 * (convert a photo, draw a sprite) plus "open what I had" — and a one-click
 * sample so nobody has to hunt for a photo before seeing what the app does.
 */
export function WelcomeScreen(props: WelcomeScreenProps) {
  const { recent } = props;
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, props.onClose);
  const [showOnStartup, setShowOnStartup] = useState(shouldShowWelcome);

  const cards: { icon: IconName; title: string; body: string; run: () => void; primary?: true }[] =
    [
      {
        icon: 'image',
        title: 'Convert a photo',
        body: 'Drop in any picture and get pixel art, live. Then keep editing it.',
        run: props.onConvertPhoto,
        primary: true,
      },
      {
        icon: 'pencil',
        title: 'New sprite',
        body: 'Start from a blank canvas with layers, palettes and animation.',
        run: props.onNewSprite,
      },
      {
        icon: 'folder',
        title: 'Open project',
        body: 'Pick up where you left off with a .tess file.',
        run: props.onOpenProject,
      },
    ];

  return (
    <div className="modal-backdrop welcome-backdrop" onClick={props.onClose}>
      <div
        className="modal welcome"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Tesserica"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="welcome-head">
          <LogoMark size={44} />
          <div>
            <h1>Tesserica</h1>
            <p>Turn any image into pixel art — then keep editing it.</p>
          </div>
        </header>

        <div className="welcome-cards">
          {cards.map((c) => (
            <button
              key={c.title}
              type="button"
              className={c.primary ? 'welcome-card primary' : 'welcome-card'}
              onClick={c.run}
            >
              <Icon name={c.icon} size={26} />
              <strong>{c.title}</strong>
              <span>{c.body}</span>
            </button>
          ))}
        </div>

        <div className="welcome-lower">
          <section aria-label="Recent files">
            <h2>
              Recent
              {recent.length > 0 && (
                <button type="button" className="link-btn" onClick={props.onClearRecent}>
                  Clear
                </button>
              )}
            </h2>
            {recent.length === 0 ? (
              <p className="welcome-muted">Files you open or save will show up here.</p>
            ) : (
              <ul className="welcome-recent">
                {recent.map((r) => (
                  <li key={r.path}>
                    <button type="button" onClick={() => props.onOpenRecent(r)} title={r.path}>
                      <Icon name={r.kind === 'project' ? 'file' : 'image'} />
                      <span>{fileName(r.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Try it">
            <h2>No photo handy?</h2>
            <button type="button" className="welcome-sample" onClick={props.onTrySample}>
              <Icon name="sparkle" />
              Try the sample photo
            </button>
            <p className="welcome-muted">
              Press <kbd>Ctrl</kbd>+<kbd>K</kbd> any time to search every command, or <kbd>?</kbd>{' '}
              for shortcuts.
            </p>
          </section>
        </div>

        <footer className="welcome-foot">
          <label>
            <input
              type="checkbox"
              checked={showOnStartup}
              onChange={(e) => {
                setShowOnStartup(e.target.checked);
                setShowWelcomeOnStartup(e.target.checked);
              }}
            />
            Show this on startup
          </label>
          <button type="button" onClick={props.onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Layer stack (`docs/05-ui-design.md` §4).
 *
 * Every mutation goes through `history/layerCommands.ts` rather than the store
 * directly, so adding, deleting, reordering, renaming and every property edit
 * are all undoable by construction.
 *
 * Accessibility (§8): visibility and lock are icons *and* `aria-pressed`, never
 * colour alone; the whole panel is reachable by keyboard.
 */

import { useRef, useState } from 'react';
import {
  addLayer,
  deleteLayer,
  moveLayer,
  renameLayer,
  setLayerLocked,
  setLayerOpacity,
  setLayerVisible,
} from '../history/layerCommands';
import { useDocumentStore } from '../state/documentStore';

export function LayerPanel() {
  const layers = useDocumentStore((s) => s.sprite.layers);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const active = layers.find((l) => l.id === activeLayerId);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // One continuous slider drag is one undo step; the counter marks where a
  // drag begins so two separate drags do not merge into each other.
  const opacitySession = useRef(0);

  const startRename = (id: string, name: string) => {
    setEditing(id);
    setDraft(name);
  };

  const commitRename = () => {
    if (editing) renameLayer(editing, draft);
    setEditing(null);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Layers</span>
        <span>
          <button title="Add layer" aria-label="Add layer" onClick={() => addLayer()}>
            +
          </button>
          <button
            title="Move layer up"
            aria-label="Move layer up"
            onClick={() => moveLayer(activeLayerId, 1)}
          >
            ↑
          </button>
          <button
            title="Move layer down"
            aria-label="Move layer down"
            onClick={() => moveLayer(activeLayerId, -1)}
          >
            ↓
          </button>
          <button
            title="Delete layer"
            aria-label="Delete layer"
            onClick={() => deleteLayer(activeLayerId)}
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
              aria-pressed={l.visible}
              title={l.visible ? 'Hide' : 'Show'}
              onClick={(e) => {
                e.stopPropagation();
                setLayerVisible(l.id, !l.visible);
              }}
            >
              {l.visible ? '◉' : '○'}
            </button>

            <button
              className="layer-vis"
              aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
              aria-pressed={l.locked}
              title={l.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation();
                setLayerLocked(l.id, !l.locked);
              }}
            >
              {l.locked ? '🔒' : '🔓'}
            </button>

            {editing === l.id ? (
              <input
                className="layer-rename"
                aria-label={`Rename ${l.name}`}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span
                className="layer-name"
                title="Double-click to rename"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(l.id, l.name);
                }}
              >
                {l.name}
              </span>
            )}
          </div>
        ))}
      </div>

      {active && (
        <>
          <label className="field">
            Blend
            {/* Normal only in v1; the rest land in Phase 3 (docs/08-roadmap.md). */}
            <select value={active.blendMode} disabled title="More blend modes arrive in Phase 3">
              <option value="normal">Normal</option>
            </select>
          </label>

          <label className="field">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(active.opacity * 100)}
              onPointerDown={() => opacitySession.current++}
              onKeyDown={() => opacitySession.current++}
              onChange={(e) =>
                setLayerOpacity(active.id, Number(e.target.value) / 100, opacitySession.current)
              }
            />
            <span className="value">{Math.round(active.opacity * 100)}%</span>
          </label>
        </>
      )}
    </section>
  );
}

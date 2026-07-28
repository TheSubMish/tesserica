/**
 * Layer stack (`docs/05-ui-design.md` §4).
 *
 * Every mutation goes through `history/layerCommands.ts` rather than the store
 * directly, so adding, deleting, reordering, renaming and every property edit
 * are all undoable by construction.
 *
 * Groups (roadmap Phase 3, "Layer groups, clipping masks") render as a tree:
 * each group's children are indented beneath it and hidden entirely while the
 * group is collapsed. There is no multi-select in this panel — the roadmap
 * explicitly keeps that minimal — so "group" wraps one layer at a time; drag
 * more layers into it afterwards with the Parent selector below.
 *
 * Accessibility (§8): visibility, lock and clipping-mask state are icons *and*
 * `aria-pressed`, never colour alone; the whole panel is reachable by keyboard.
 */

import { useRef, useState } from 'react';
import { SliderField } from '../app/SliderField';
import {
  addGroup,
  addLayer,
  deleteLayer,
  groupLayer,
  moveLayer,
  renameLayer,
  setLayerBlendMode,
  setLayerClippingMask,
  setLayerLocked,
  setLayerOpacity,
  setLayerParent,
  setLayerVisible,
  ungroupLayer,
} from '../history/layerCommands';
import { childrenOf, wouldCreateCycle } from '../model/layerTree';
import type { BlendMode, Layer, LayerId } from '../model/types';
import { useDocumentStore } from '../state/documentStore';

/** `docs/03-data-model.md` §2.1 — the full W3C set, in the order Photoshop-family tools use. */
const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

interface Row {
  layer: Layer;
  depth: number;
}

/**
 * Top-of-stack-first display order, each group's children indented directly
 * beneath it and omitted entirely while the group is collapsed.
 *
 * The underlying `Sprite.layers` array does not require a group's children to
 * be contiguous with it (`model/layerTree.ts`) — this is what reconstructs
 * the visual tree from that flat, possibly-interleaved storage.
 */
function visibleRows(layers: Layer[]): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: LayerId | null, depth: number): void => {
    for (const l of [...childrenOf(layers, parentId)].reverse()) {
      rows.push({ layer: l, depth });
      if (l.kind === 'group' && !l.collapsed) walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

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

  const groups = layers.filter((l): l is Layer & { kind: 'group' } => l.kind === 'group');

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Layers</span>
        <span>
          <button title="Add layer" aria-label="Add layer" onClick={() => addLayer()}>
            +
          </button>
          <button title="New group" aria-label="New group" onClick={() => addGroup()}>
            📁
          </button>
          <button
            title="Group layer"
            aria-label="Group layer"
            onClick={() => groupLayer(activeLayerId)}
          >
            ⊞
          </button>
          <button
            title="Ungroup"
            aria-label="Ungroup"
            disabled={active?.kind !== 'group'}
            onClick={() => ungroupLayer(activeLayerId)}
          >
            ⊟
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
        {visibleRows(layers).map(({ layer: l, depth }) => (
          <div
            key={l.id}
            className="layer-row"
            role="option"
            tabIndex={0}
            aria-selected={l.id === activeLayerId}
            style={{ paddingLeft: `calc(var(--space-1) + ${depth * 12}px)` }}
            onClick={() => useDocumentStore.getState().setActiveLayer(l.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                useDocumentStore.getState().setActiveLayer(l.id);
                e.preventDefault();
              }
            }}
          >
            {/* Only groups get a disclosure triangle; everything else keeps
                its slot blank so names still line up in a column. */}
            {l.kind === 'group' ? (
              <button
                className="layer-vis"
                aria-label={l.collapsed ? `Expand ${l.name}` : `Collapse ${l.name}`}
                aria-expanded={!l.collapsed}
                title={l.collapsed ? 'Expand' : 'Collapse'}
                onClick={(e) => {
                  e.stopPropagation();
                  useDocumentStore.getState().setGroupCollapsed(l.id, !l.collapsed);
                }}
              >
                <span aria-hidden="true">{l.collapsed ? '▸' : '▾'}</span>
              </button>
            ) : (
              <span className="layer-vis" aria-hidden="true" />
            )}

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

            {/* "Clip to layer below" (roadmap Phase 3) — scoped to l's own group. */}
            <button
              className="layer-vis"
              aria-label={
                l.clippingMask
                  ? `Unclip ${l.name} from the layer below`
                  : `Clip ${l.name} to the layer below`
              }
              aria-pressed={l.clippingMask}
              title={l.clippingMask ? 'Clipped to layer below' : 'Clip to layer below'}
              onClick={(e) => {
                e.stopPropagation();
                setLayerClippingMask(l.id, !l.clippingMask);
              }}
            >
              {l.clippingMask ? '⧉' : '⬚'}
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
            Parent
            <select
              aria-label="Parent group"
              value={active.parentId ?? ''}
              onChange={(e) => setLayerParent(active.id, e.target.value || null)}
            >
              <option value="">Top level</option>
              {groups
                .filter((g) => g.id !== active.id && !wouldCreateCycle(layers, active.id, g.id))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </label>

          <label className="field">
            Blend
            <select
              aria-label="Blend mode"
              value={active.blendMode}
              onChange={(e) => setLayerBlendMode(active.id, e.target.value as BlendMode)}
            >
              {BLEND_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <SliderField
            label="Opacity"
            min={0}
            max={100}
            value={Math.round(active.opacity * 100)}
            format={(v) => `${v}%`}
            onDragStart={() => opacitySession.current++}
            onChange={(v) => setLayerOpacity(active.id, v / 100, opacitySession.current)}
          />
        </>
      )}
    </section>
  );
}

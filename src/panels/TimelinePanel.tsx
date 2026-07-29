/**
 * Timeline panel (`docs/05-ui-design.md` §5, `docs/08-roadmap.md` Phase 4).
 *
 * A toggleable panel **inside Edit mode**, not a third mode
 * (`docs/10-decisions.md` D7) — hidden by default, shown via the title bar's
 * Timeline button or the `T` shortcut (`app/shortcuts.ts`).
 *
 * The grid is the direct visual expression of the layer×frame cel model
 * (`docs/03-data-model.md` §2.2): rows are the same layer tree the layer
 * panel shows (`model/layerTree.ts::visibleLayerRows`, not reinvented here),
 * columns are frames, and each cell shows whether that layer has a cel on
 * that frame — a filled dot for an independent ("canonical") cel, a chain
 * icon for one that shares another frame's buffer (`Cel.linkedTo`). Group
 * rows never have cels of their own, so their cells are always blank.
 *
 * **Linking gesture**: select the frame you want to be canonical (click its
 * column header, or click a cell in that row — either sets the active
 * layer+frame), then click the small link button that appears on any other,
 * still-independent cel in that same row to point it at the active one. A
 * cell that is already linked shows an unlink button instead. This is the
 * smallest reasonable gesture given there is no context-menu component
 * anywhere else in the app to match (`docs/05-ui-design.md` does not specify
 * one either).
 *
 * A single CSS grid (`.timeline-grid`) holds everything — the corner cell,
 * frame headers, row labels and cel cells all as direct children in row-major
 * order, so `grid-template-columns` (`label-width, frame-width × N`) is the
 * only layout rule needed; React fragments keep each row's label+cells
 * adjacent in markup without adding a wrapping element that would break that
 * flat child order.
 *
 * Onion skinning's toggle and before/after range live in the transport row,
 * next to Play (`docs/05-ui-design.md` §5's own mockup puts "◐ onion" there).
 * The overlay itself is drawn by `CanvasView`/`canvas/renderer.ts::
 * drawOnionSkin` — this panel only owns the two numbers and the on/off
 * switch, all in `state/uiStore.ts` since they are view state, never
 * document state. Tags (`docs/08-roadmap.md` Phase 4, next bullet) are
 * deliberately not part of this panel yet.
 */

import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import {
  addFrame,
  deleteFrame,
  duplicateFrame,
  linkCel,
  moveFrame,
  setFrameDuration,
  unlinkCel,
} from '../history/frameCommands';
import { visibleLayerRows } from '../model/layerTree';
import type { Cel, Frame, FrameId, Layer } from '../model/types';
import { useDocumentStore } from '../state/documentStore';
import { MAX_ONION_SKIN_RANGE, useUIStore } from '../state/uiStore';
import {
  celAt,
  nextFrameIndex,
  prevFrameIndex,
  startPlayback,
  type PlaybackHandle,
} from './timeline';

export function TimelinePanel() {
  const sprite = useDocumentStore((s) => s.sprite);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const activeFrameId = useDocumentStore((s) => s.activeFrameId);

  const onionSkinEnabled = useUIStore((s) => s.onionSkinEnabled);
  const onionSkinBefore = useUIStore((s) => s.onionSkinBefore);
  const onionSkinAfter = useUIStore((s) => s.onionSkinAfter);

  const rows = visibleLayerRows(sprite.layers);
  const frames = sprite.frames;

  const [playing, setPlaying] = useState(false);
  const playbackRef = useRef<PlaybackHandle | null>(null);
  // One continuous edit of a duration field is one undo step; the map tracks
  // a session counter per frame the same way `LayerPanel`'s opacity slider
  // does with a single ref, just keyed by frame id since many can exist here.
  const durationSessions = useRef(new Map<FrameId, number>());

  const stopPlayback = () => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlaying(false);
  };

  // Stop playback if the panel unmounts (e.g. it is hidden, or the app
  // switches to Convert mode) while it is running.
  useEffect(() => stopPlayback, []);

  const togglePlay = () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (frames.length < 2) return;
    playbackRef.current = startPlayback(
      () => useDocumentStore.getState().sprite.frames,
      () => useDocumentStore.getState().activeFrameId,
      (frameId) => useDocumentStore.getState().setActiveFrame(frameId),
    );
    setPlaying(true);
  };

  const stop = () => {
    stopPlayback();
    const first = useDocumentStore.getState().sprite.frames[0];
    if (first) useDocumentStore.getState().setActiveFrame(first.id);
  };

  const step = (delta: number) => {
    const doc = useDocumentStore.getState();
    const idx = doc.frameIndex(doc.activeFrameId);
    const count = doc.sprite.frames.length;
    const next = delta > 0 ? nextFrameIndex(idx, count) : prevFrameIndex(idx, count);
    const target = doc.sprite.frames[next];
    if (target) doc.setActiveFrame(target.id);
  };

  const activeCel = celAt(sprite, activeLayerId, activeFrameId);
  const canLinkToActive = activeCel !== undefined && activeCel.linkedTo === undefined;
  // Resolves a linked cel's target to the frame index it names, for the
  // "linked to frame N" label — cheap to build once per render given the
  // frame counts animation actually deals in.
  const frameIndexOfCel = new Map<string, number>();
  for (const c of sprite.cels) {
    const idx = frames.findIndex((f) => f.id === c.frameId);
    if (idx >= 0) frameIndexOfCel.set(c.id, idx);
  }

  const selectCel = (layerId: string, frameId: FrameId) => {
    const doc = useDocumentStore.getState();
    doc.setActiveLayer(layerId);
    doc.setActiveFrame(frameId);
  };

  return (
    <section className="panel timeline-panel">
      <div className="panel-head">
        <span>Timeline</span>
        <span className="timeline-transport">
          <button
            title="Previous frame"
            aria-label="Previous frame"
            disabled={playing || frames.length < 2}
            onClick={() => step(-1)}
          >
            ⏮
          </button>
          <button
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
            aria-pressed={playing}
            disabled={frames.length < 2}
            onClick={togglePlay}
          >
            {playing ? '⏸' : '⏵'}
          </button>
          <button title="Stop" aria-label="Stop" disabled={!playing} onClick={stop}>
            ⏹
          </button>
          <button
            title="Next frame"
            aria-label="Next frame"
            disabled={playing || frames.length < 2}
            onClick={() => step(1)}
          >
            ⏭
          </button>
        </span>
        <span className="timeline-onion" title="Onion skinning — ghosted nearby frames">
          <button
            className="timeline-onion-toggle"
            aria-label="Toggle onion skinning"
            aria-pressed={onionSkinEnabled}
            disabled={frames.length < 2}
            onClick={() => useUIStore.getState().toggleOnionSkin()}
          >
            ◐ onion
          </button>
          <label className="timeline-onion-range">
            <span aria-hidden="true">−</span>
            <input
              type="number"
              min={0}
              max={MAX_ONION_SKIN_RANGE}
              aria-label="Frames before to ghost"
              title="Frames before to ghost"
              disabled={!onionSkinEnabled}
              value={onionSkinBefore}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) useUIStore.getState().setOnionSkinBefore(v);
              }}
            />
          </label>
          <label className="timeline-onion-range">
            <span aria-hidden="true">+</span>
            <input
              type="number"
              min={0}
              max={MAX_ONION_SKIN_RANGE}
              aria-label="Frames after to ghost"
              title="Frames after to ghost"
              disabled={!onionSkinEnabled}
              value={onionSkinAfter}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) useUIStore.getState().setOnionSkinAfter(v);
              }}
            />
          </label>
        </span>
        <span className="timeline-frame-ops">
          <button title="Add frame" aria-label="Add frame" onClick={() => addFrame(activeFrameId)}>
            +
          </button>
          <button
            title="Duplicate frame"
            aria-label="Duplicate frame"
            onClick={() => duplicateFrame(activeFrameId)}
          >
            ⧉
          </button>
          <button
            title="Move frame earlier"
            aria-label="Move frame earlier"
            onClick={() => moveFrame(activeFrameId, -1)}
          >
            ←
          </button>
          <button
            title="Move frame later"
            aria-label="Move frame later"
            onClick={() => moveFrame(activeFrameId, 1)}
          >
            →
          </button>
          <button
            title="Delete frame"
            aria-label="Delete frame"
            disabled={frames.length <= 1}
            onClick={() => deleteFrame(activeFrameId)}
          >
            🗑
          </button>
        </span>
      </div>

      <div className="timeline-grid-wrap">
        <div
          className="timeline-grid"
          role="grid"
          aria-label="Layer by frame timeline"
          style={{ gridTemplateColumns: `140px repeat(${Math.max(frames.length, 1)}, 56px)` }}
        >
          <div className="timeline-corner" role="presentation" />
          {frames.map((f, i) => (
            <FrameHead
              key={f.id}
              frame={f}
              index={i}
              active={f.id === activeFrameId}
              sessionRef={durationSessions}
            />
          ))}

          {rows.map(({ layer, depth }) => (
            <Fragment key={layer.id}>
              <div
                className="timeline-row-label"
                style={{ paddingLeft: `calc(var(--space-1) + ${depth * 12}px)` }}
                title={layer.name}
              >
                {layer.name}
              </div>
              {frames.map((f) => {
                const cel = layer.kind === 'group' ? undefined : celAt(sprite, layer.id, f.id);
                return (
                  <TimelineCell
                    key={f.id}
                    layer={layer}
                    frame={f}
                    cel={cel}
                    isActive={layer.id === activeLayerId && f.id === activeFrameId}
                    showLinkButton={
                      layer.id === activeLayerId && f.id !== activeFrameId && canLinkToActive
                    }
                    frameIndexOfCel={frameIndexOfCel}
                    onSelect={() => selectCel(layer.id, f.id)}
                    onLink={() => {
                      if (activeCel && cel) linkCel(cel.id, activeCel.id);
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}

function FrameHead({
  frame,
  index,
  active,
  sessionRef,
}: {
  frame: Frame;
  index: number;
  active: boolean;
  /** Passed as a ref object, not `.current`, so reading it stays inside
      event handlers rather than this component's render. */
  sessionRef: RefObject<Map<FrameId, number>>;
}) {
  return (
    <div className={active ? 'timeline-frame-head active' : 'timeline-frame-head'}>
      <button
        className="timeline-frame-number"
        aria-pressed={active}
        aria-label={`Select frame ${index + 1}`}
        onClick={() => useDocumentStore.getState().setActiveFrame(frame.id)}
      >
        {index + 1}
      </button>
      <input
        className="timeline-duration"
        type="number"
        min={1}
        aria-label={`Duration in milliseconds for frame ${index + 1}`}
        value={frame.durationMs}
        onFocus={() => {
          const session = sessionRef.current;
          session.set(frame.id, (session.get(frame.id) ?? 0) + 1);
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          setFrameDuration(frame.id, v, sessionRef.current.get(frame.id) ?? 0);
        }}
      />
    </div>
  );
}

function TimelineCell({
  layer,
  frame,
  cel,
  isActive,
  showLinkButton,
  frameIndexOfCel,
  onSelect,
  onLink,
}: {
  layer: Layer;
  frame: Frame;
  cel: Cel | undefined;
  isActive: boolean;
  showLinkButton: boolean;
  frameIndexOfCel: Map<string, number>;
  onSelect: () => void;
  onLink: () => void;
}) {
  if (layer.kind === 'group' || !cel) {
    return <div className="timeline-cell timeline-cell-empty" aria-hidden="true" />;
  }

  const linked = cel.linkedTo !== undefined;
  const linkedFrameNumber = linked ? (frameIndexOfCel.get(cel.linkedTo!) ?? -1) + 1 : 0;

  return (
    <div
      className={isActive ? 'timeline-cell timeline-cell-active' : 'timeline-cell'}
      role="button"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={`${layer.name}, frame ${frame.id}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect();
          e.preventDefault();
        }
      }}
    >
      {linked ? (
        <button
          className="timeline-link-btn timeline-link-btn-linked"
          title={`Linked to frame ${linkedFrameNumber} — click to unlink`}
          aria-label={`Unlink ${layer.name} from frame ${linkedFrameNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            unlinkCel(cel.id);
          }}
        >
          ⛓
        </button>
      ) : (
        <span className="timeline-dot" aria-hidden="true">
          ●
        </span>
      )}
      {!linked && showLinkButton && (
        <button
          className="timeline-link-btn"
          title="Link this cel to the active frame's cel"
          aria-label={`Link ${layer.name} to the active frame`}
          onClick={(e) => {
            e.stopPropagation();
            onLink();
          }}
        >
          ⇗
        </button>
      )}
    </div>
  );
}

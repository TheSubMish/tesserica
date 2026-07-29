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
 * document state.
 *
 * **Tags** (`docs/03-data-model.md` §2.3) get their own row inside the same
 * `.timeline-grid` — same column template as the frame-head/cel rows, so a
 * tag's colored span always lines up with the frames it covers regardless of
 * horizontal scroll, without duplicating the column math. `docs/05-ui-design.md`
 * §5's prose calls these "colored spans above the frames"; its own ASCII
 * mockup instead draws them as a flat list of chips in the toolbar, which
 * would not stay aligned with anything — the prose is what a real grid can
 * satisfy, so that is what this follows. The "+ Tag" button lives in that
 * row's label column and opens a one-row inline form (name — the six presets
 * from `model/tags.ts::TAG_PRESET_NAMES` plus a custom text field — and a
 * from/to frame range); clicking an existing tag's span opens a second inline
 * row to rename it, edit its range/direction, play back scoped to just its
 * frames (`model/tags.ts::tagFrameSequence` feeds the same `startPlayback`
 * scheduler whole-sprite playback uses below, pre-ordered for
 * forward/reverse/pingpong so the scheduler itself needs no tag-specific
 * branch), or delete it. Both inline rows span every column
 * (`gridColumn: '1 / -1'`) rather than sitting in the label column alone,
 * since their controls need more width than 140px.
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
import { addTag, deleteTag, renameTag, setTagDirection, setTagRange } from '../history/tagCommands';
import { visibleLayerRows } from '../model/layerTree';
import { TAG_PRESET_NAMES, tagFrameSequence } from '../model/tags';
import type { Cel, Frame, FrameId, Layer, Tag, TagDirection, TagId } from '../model/types';
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

  // `'all'` is whole-sprite playback (the transport row); any other string is
  // the id of the tag currently playing scoped to its own range. Only one
  // playback can run at a time, sharing the single scheduler handle below —
  // starting either kind stops the other first.
  const [playingKind, setPlayingKind] = useState<'all' | TagId | null>(null);
  const playbackRef = useRef<PlaybackHandle | null>(null);
  const wholePlaying = playingKind === 'all';
  const anyPlaying = playingKind !== null;
  // One continuous edit of a duration field is one undo step; the map tracks
  // a session counter per frame the same way `LayerPanel`'s opacity slider
  // does with a single ref, just keyed by frame id since many can exist here.
  const durationSessions = useRef(new Map<FrameId, number>());
  // Same coalescing trick, keyed by tag id, for the tag-range editor's
  // from/to fields.
  const tagRangeSessions = useRef(new Map<TagId, number>());

  const [selectedTagId, setSelectedTagId] = useState<TagId | null>(null);
  const [tagFormOpen, setTagFormOpen] = useState(false);
  const [tagFormPreset, setTagFormPreset] = useState<string>(TAG_PRESET_NAMES[0]);
  const [tagFormCustomName, setTagFormCustomName] = useState('');
  const [tagFormFrom, setTagFormFrom] = useState(0);
  const [tagFormTo, setTagFormTo] = useState(0);

  const stopPlayback = () => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlayingKind(null);
  };

  // Stop playback if the panel unmounts (e.g. it is hidden, or the app
  // switches to Convert mode) while it is running.
  useEffect(() => stopPlayback, []);

  const togglePlay = () => {
    if (wholePlaying) {
      stopPlayback();
      return;
    }
    if (frames.length < 2) return;
    stopPlayback(); // in case a tag was playing
    playbackRef.current = startPlayback(
      () => useDocumentStore.getState().sprite.frames,
      () => useDocumentStore.getState().activeFrameId,
      (frameId) => useDocumentStore.getState().setActiveFrame(frameId),
    );
    setPlayingKind('all');
  };

  const stop = () => {
    stopPlayback();
    const first = useDocumentStore.getState().sprite.frames[0];
    if (first) useDocumentStore.getState().setActiveFrame(first.id);
  };

  /** Playback bounded to one tag's own frame range, honouring its direction. */
  const playTag = (tagId: TagId) => {
    if (playingKind === tagId) {
      stopPlayback();
      return;
    }
    const getScopedFrames = () => {
      const doc = useDocumentStore.getState();
      const tag = doc.sprite.tags.find((t) => t.id === tagId);
      return tag ? tagFrameSequence(doc.sprite.frames, tag) : [];
    };
    const first = getScopedFrames()[0];
    if (!first) return;
    stopPlayback(); // in case whole-sprite playback (or another tag) was running
    useDocumentStore.getState().setActiveFrame(first.id);
    playbackRef.current = startPlayback(
      getScopedFrames,
      () => useDocumentStore.getState().activeFrameId,
      (frameId) => useDocumentStore.getState().setActiveFrame(frameId),
    );
    setPlayingKind(tagId);
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

  const selectedTag = sprite.tags.find((t) => t.id === selectedTagId);

  const openTagForm = () => {
    if (tagFormOpen) {
      setTagFormOpen(false);
      return;
    }
    const idx = frames.findIndex((f) => f.id === activeFrameId);
    const i = idx < 0 ? 0 : idx;
    setTagFormFrom(i);
    setTagFormTo(i);
    setTagFormPreset(TAG_PRESET_NAMES[0]);
    setTagFormCustomName('');
    setTagFormOpen(true);
  };

  const submitTagForm = () => {
    const name = tagFormPreset === 'custom' ? tagFormCustomName : tagFormPreset;
    if (!name.trim()) return;
    addTag(name, tagFormFrom, tagFormTo);
    setTagFormOpen(false);
  };

  return (
    <section className="panel timeline-panel">
      <div className="panel-head">
        <span>Timeline</span>
        <span className="timeline-transport">
          <button
            title="Previous frame"
            aria-label="Previous frame"
            disabled={anyPlaying || frames.length < 2}
            onClick={() => step(-1)}
          >
            ⏮
          </button>
          <button
            title={wholePlaying ? 'Pause' : 'Play'}
            aria-label={wholePlaying ? 'Pause' : 'Play'}
            aria-pressed={wholePlaying}
            disabled={frames.length < 2}
            onClick={togglePlay}
          >
            {wholePlaying ? '⏸' : '⏵'}
          </button>
          <button title="Stop" aria-label="Stop" disabled={!anyPlaying} onClick={stop}>
            ⏹
          </button>
          <button
            title="Next frame"
            aria-label="Next frame"
            disabled={anyPlaying || frames.length < 2}
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

          <div className="timeline-tags-label">
            <button
              className="timeline-tag-add-btn"
              title="Add tag"
              aria-label="Add tag"
              aria-pressed={tagFormOpen}
              onClick={openTagForm}
            >
              + Tag
            </button>
          </div>
          {frames.map((f, i) => {
            const covering = sprite.tags.find((t) => i >= t.from && i <= t.to);
            return (
              <TagSpanCell
                key={f.id}
                index={i}
                tag={covering}
                selected={covering !== undefined && covering.id === selectedTagId}
                onSelect={() =>
                  covering && setSelectedTagId(covering.id === selectedTagId ? null : covering.id)
                }
              />
            );
          })}

          {tagFormOpen && (
            <div className="timeline-tag-form" style={{ gridColumn: '1 / -1' }}>
              <label>
                <span aria-hidden="true">Name</span>
                <select
                  aria-label="Tag preset name"
                  value={tagFormPreset}
                  onChange={(e) => setTagFormPreset(e.target.value)}
                >
                  {TAG_PRESET_NAMES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
              </label>
              {tagFormPreset === 'custom' && (
                <input
                  type="text"
                  placeholder="Tag name"
                  aria-label="Custom tag name"
                  value={tagFormCustomName}
                  onChange={(e) => setTagFormCustomName(e.target.value)}
                />
              )}
              <label>
                <span aria-hidden="true">From</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(frames.length, 1)}
                  aria-label="Tag start frame"
                  value={tagFormFrom + 1}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setTagFormFrom(v - 1);
                  }}
                />
              </label>
              <label>
                <span aria-hidden="true">To</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(frames.length, 1)}
                  aria-label="Tag end frame"
                  value={tagFormTo + 1}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setTagFormTo(v - 1);
                  }}
                />
              </label>
              <button onClick={submitTagForm}>Create</button>
              <button onClick={() => setTagFormOpen(false)}>Cancel</button>
            </div>
          )}

          {selectedTag && (
            <TagEditor
              key={selectedTag.id}
              tag={selectedTag}
              frameCount={frames.length}
              playing={playingKind === selectedTag.id}
              sessionRef={tagRangeSessions}
              onPlay={() => playTag(selectedTag.id)}
              onDelete={() => {
                deleteTag(selectedTag.id);
                setSelectedTagId(null);
              }}
              onClose={() => setSelectedTagId(null)}
            />
          )}

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

/**
 * One frame-column's worth of a tag's colored span. Blank when no tag covers
 * this index; the tag's name is only drawn in the leftmost cell of its span
 * (`index === tag.from`) so it does not repeat once per frame the tag covers.
 */
function TagSpanCell({
  index,
  tag,
  selected,
  onSelect,
}: {
  index: number;
  tag: Tag | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!tag) {
    return <div className="timeline-tag-cell timeline-tag-cell-empty" aria-hidden="true" />;
  }
  return (
    <div
      className={selected ? 'timeline-tag-cell timeline-tag-cell-selected' : 'timeline-tag-cell'}
      style={{ background: tag.color }}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`Tag ${tag.name}, frames ${tag.from + 1} to ${tag.to + 1}`}
      title={`${tag.name} (frames ${tag.from + 1}–${tag.to + 1})`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect();
          e.preventDefault();
        }
      }}
    >
      {index === tag.from && <span className="timeline-tag-name">{tag.name}</span>}
    </div>
  );
}

/**
 * Inline editor for the tag currently selected in the tags row — rename,
 * edit its frame range and direction, play back scoped to just it, or delete
 * it. Spans every grid column (`gridColumn: '1 / -1'`, set by the caller)
 * since its controls need more room than the 140px label column.
 */
function TagEditor({
  tag,
  frameCount,
  playing,
  sessionRef,
  onPlay,
  onDelete,
  onClose,
}: {
  tag: Tag;
  frameCount: number;
  playing: boolean;
  sessionRef: RefObject<Map<TagId, number>>;
  onPlay: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const bumpSession = () => {
    const session = sessionRef.current;
    session.set(tag.id, (session.get(tag.id) ?? 0) + 1);
  };
  const session = () => sessionRef.current.get(tag.id) ?? 0;

  return (
    <div className="timeline-tag-editor" style={{ gridColumn: '1 / -1' }}>
      <input
        type="text"
        aria-label="Tag name"
        value={tag.name}
        onChange={(e) => renameTag(tag.id, e.target.value)}
      />
      <label>
        <span aria-hidden="true">From</span>
        <input
          type="number"
          min={1}
          max={Math.max(frameCount, 1)}
          aria-label="Edit tag start frame"
          value={tag.from + 1}
          onFocus={bumpSession}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setTagRange(tag.id, v - 1, tag.to, session());
          }}
        />
      </label>
      <label>
        <span aria-hidden="true">To</span>
        <input
          type="number"
          min={1}
          max={Math.max(frameCount, 1)}
          aria-label="Edit tag end frame"
          value={tag.to + 1}
          onFocus={bumpSession}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setTagRange(tag.id, tag.from, v - 1, session());
          }}
        />
      </label>
      <label>
        <span aria-hidden="true">Direction</span>
        <select
          aria-label="Tag playback direction"
          value={tag.direction}
          onChange={(e) => setTagDirection(tag.id, e.target.value as TagDirection)}
        >
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
          <option value="pingpong">Ping-pong</option>
        </select>
      </label>
      <button
        aria-label={playing ? `Pause ${tag.name}` : `Play ${tag.name}`}
        aria-pressed={playing}
        disabled={frameCount < 2}
        onClick={onPlay}
      >
        {playing ? '⏸' : '⏵'} tag
      </button>
      <button aria-label={`Delete tag ${tag.name}`} onClick={onDelete}>
        🗑
      </button>
      <button aria-label="Close tag editor" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

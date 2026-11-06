import type { ReactNode } from 'react';

/**
 * One consistent icon set, drawn on a 16×16 grid with a 1.5px round stroke in
 * `currentColor`, so icons follow the button's text colour and states.
 *
 * Replaces emoji glyphs (🪣 💧 🧩 📁 🗑), which render from whichever colour-emoji
 * font a Linux box happens to have — different size, weight and palette on every
 * machine, and never themed.
 */
const PATHS = {
  pencil: <path d="M3 13l.8-3.2L10.6 3l2.4 2.4-6.8 6.8L3 13zM9.2 4.4l2.4 2.4" />,
  eraser: (
    <path d="M6.5 13.5H13M3.4 9.6l5.2-5.9a1 1 0 0 1 1.4-.1l2.4 2.1a1 1 0 0 1 .1 1.4L8 13H5.6L3.5 11a1 1 0 0 1-.1-1.4z" />
  ),
  fill: (
    <>
      <path d="M2.8 8.2L7.6 3.4l5 5-4.2 4.2a1.2 1.2 0 0 1-1.7 0L2.8 8.8a.4.4 0 0 1 0-.6zM3 8.6h9.4" />
      <path d="M13.4 10.6c.7 1 1.2 1.6 1.2 2.2a1.2 1.2 0 0 1-2.4 0c0-.6.5-1.2 1.2-2.2z" />
    </>
  ),
  line: <path d="M3 13L13 3" />,
  rect: <rect x="3" y="4" width="10" height="8" rx="0.5" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="4" />,
  eyedropper: (
    <path d="M10.2 2.8l3 3-1.3 1.3-3-3 1.3-1.3zM9 4.8L3.6 10.2 3 13l2.8-.6L11.2 7M7.4 6.4l2.2 2.2" />
  ),
  select: <rect x="3" y="3" width="10" height="10" strokeDasharray="2 2" />,
  move: (
    <path d="M8 2v12M2 8h12M8 2L6.2 3.8M8 2l1.8 1.8M8 14l-1.8-1.8M8 14l1.8-1.8M2 8l1.8-1.8M2 8l1.8 1.8M14 8l-1.8-1.8M14 8l-1.8 1.8" />
  ),
  zoom: <path d="M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5M5.5 7h3M7 5.5v3" />,
  stamp: <path d="M6.2 3h3.6v3.6L12 8.6V11H4V8.6l2.2-2V3zM3 13.4h10" />,
  transform: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4v3h-3" />,
  plus: <path d="M8 3v10M3 8h10" />,
  folder: <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" />,
  group: <path d="M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z" />,
  ungroup: <path d="M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5z" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />,
  swap: <path d="M5 2.5v10M2.5 10L5 12.5 7.5 10M11 13.5v-10M8.5 6L11 3.5 13.5 6" />,
  timeline: <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6 6.5v6M10 6.5v6" />,
  search: <path d="M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5" />,
  image: <path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.2h.01" />,
  file: <path d="M4 2.5h5.5L12.5 5.5v8H4zM9.5 2.5v3h3" />,
  sparkle: (
    <path d="M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3zM12.5 11.5v3M11 13h3" />
  ),
  keyboard: <path d="M2 4.5h12v7H2zM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6" />,
  command: (
    <path d="M5.5 5.5v-1a1.5 1.5 0 1 0-1.5 1.5h8a1.5 1.5 0 1 0-1.5-1.5v7a1.5 1.5 0 1 0 1.5-1.5H4a1.5 1.5 0 1 0 1.5 1.5z" />
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  ramp: <path d="M2.5 11.5h2.8v-2h2.8v-2h2.8v-2H13.5" />,
  lock: <path d="M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2" />,
  solo: (
    <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM2 8h2.5M11.5 8H14M8 2v2.5M8 11.5V14" />
  ),
  merge: <path d="M4 2.5v3.5a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3V2.5M8 9v4.5M6 11.8l2 2 2-2" />,
  flatten: <path d="M2.5 3.5h11M2.5 6.5h11M8 9v4.5M6 11.8l2 2 2-2" />,
  mirror: <path d="M8 2v12M5.5 4.5L2.5 8l3 3.5zM10.5 4.5l3 3.5-3 3.5z" />,
  palette: (
    <path d="M8 2.5a5.5 5.5 0 1 0 0 11c1 0 1.4-.7 1.1-1.4-.4-.9.1-1.6 1-1.6h1.3a2 2 0 0 0 2-2A6.2 6.2 0 0 0 8 2.5zM5.2 8h.01M6.6 5.4h.01M9.6 5.4h.01" />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * The mark: four mosaic tiles (a *tessera* is one tile of a mosaic), one of
 * them lifted out — the convert → edit hand-off.
 */
export function LogoMark({ size = 20 }: { readonly size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="8" height="8" rx="1.5" fill="#6c9fff" />
      <rect x="11" y="1" width="8" height="8" rx="1.5" fill="#ff8fb3" />
      <rect x="1" y="11" width="8" height="8" rx="1.5" fill="#7be0a8" />
      <rect
        x="11"
        y="11"
        width="8"
        height="8"
        rx="1.5"
        fill="#ffd166"
        transform="translate(1 -1)"
      />
    </svg>
  );
}

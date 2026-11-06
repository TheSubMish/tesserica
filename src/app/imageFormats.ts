/**
 * The image-format-conversion dialog's own format list
 * (`src-tauri/src/commands/format_convert.rs`).
 *
 * Kept as a plain array here rather than derived from anywhere else: the
 * canonical list lives in Rust's `SUPPORTED_FORMATS` (gated by `Cargo.toml`'s
 * `image` features), and this is its frontend twin. The two must change
 * together — adding a format means updating both.
 *
 * `id` is exactly the string `format_convert::parse_format` expects.
 * `extensions` drives the save dialog's filter and default filename; the
 * first entry is the one appended to a picked filename.
 */
export interface ImageFormatOption {
  id: string;
  label: string;
  extensions: string[];
}

export const IMAGE_FORMAT_OPTIONS: ImageFormatOption[] = [
  { id: 'png', label: 'PNG', extensions: ['png'] },
  { id: 'jpeg', label: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { id: 'gif', label: 'GIF', extensions: ['gif'] },
  { id: 'webp', label: 'WebP', extensions: ['webp'] },
  { id: 'bmp', label: 'BMP', extensions: ['bmp'] },
  { id: 'ico', label: 'ICO', extensions: ['ico'] },
  { id: 'tiff', label: 'TIFF', extensions: ['tiff', 'tif'] },
  { id: 'tga', label: 'TGA', extensions: ['tga'] },
  { id: 'pnm', label: 'PNM', extensions: ['pnm', 'ppm', 'pgm', 'pbm'] },
  { id: 'qoi', label: 'QOI', extensions: ['qoi'] },
  { id: 'ff', label: 'farbfeld', extensions: ['ff'] },
  { id: 'hdr', label: 'Radiance HDR', extensions: ['hdr'] },
  { id: 'exr', label: 'OpenEXR', extensions: ['exr'] },
];

/**
 * Every extension `image::open` in the Rust backend can decode — the
 * conversion dialog's *source*-file picker filter. A superset of
 * `IMAGE_FORMAT_OPTIONS`'s own extensions plus uppercase variants, since a
 * Linux GTK file-chooser glob is case-sensitive (the same reasoning
 * `src/app/project.ts`'s `pickImage` already documents for PNG/JPEG).
 */
export const ALL_CONVERTIBLE_EXTENSIONS: string[] = IMAGE_FORMAT_OPTIONS.flatMap((f) => [
  ...f.extensions,
  ...f.extensions.map((e) => e.toUpperCase()),
]);

export function formatById(id: string): ImageFormatOption | undefined {
  return IMAGE_FORMAT_OPTIONS.find((f) => f.id === id);
}

/** The filename `input` would have if saved with `format`'s first extension. */
export function withFormatExtension(input: string, format: ImageFormatOption): string {
  const base = input.slice(input.lastIndexOf('/') + 1).replace(/\.[^./]+$/, '');
  return `${base}.${format.extensions[0]}`;
}

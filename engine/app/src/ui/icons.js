// Line icons (SVG markup, drawn in the text's colour): a size given, the rest from the CSS.
const icon = (size, paths) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths}"/></svg>`;

const BIN_PATHS = 'M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.8 9h6.4l.8-9M6.75 7v4.5M9.25 7v4.5';

/** A bin, small: delete this (a gallery tile's corner). */
export const BIN = icon(14, BIN_PATHS);

/** A bin, a bar button's size: empty the scene. */
export const CLEAR = icon(20, BIN_PATHS);

/** An arrow down onto a tray: download. */
export const DOWNLOAD = icon(20, 'M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M2.5 13.5h11');

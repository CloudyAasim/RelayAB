/**
 * One motion recipe for the whole panel.
 *
 * The sidebar is a single object: a column of rows, a brand at the top, a
 * footer of two rows. Every surface in it has to move the same way, or the
 * panel reads as pieces assembled from different kits — a nav row that eases
 * in over 300ms next to an account button that snaps in 150ms on the
 * default curve is exactly that.
 *
 * Two recipes, and only two:
 *
 *   CONTROL — the things you press. They change colour (and, for the nav rows,
 *   padding). Fast on the way in, unhurried on the way out: `hover:duration-150`
 *   makes the pointer's arrival snappy and the departure soft.
 *
 *   LABEL — the text that collapses when the rail narrows. It is measured, so
 *   it animates on width and opacity, never on anything the browser cannot
 *   interpolate.
 *
 * `ease-sidebar` is the panel's curve (`cubic-bezier(0.32, 0.72, 0, 1)`) —
 * the same one the rail's own width uses, so the rows and the rail settle
 * together instead of chasing each other.
 *
 * `motion-reduce:transition-none` everywhere: the point of the animation is
 * to explain the movement, and for someone who asked for less motion there
 * should be none to explain.
 */
export const SIDEBAR_CONTROL_MOTION =
  "transition-[padding,background-color,color] duration-300 ease-sidebar hover:duration-150 motion-reduce:transition-none";

export const SIDEBAR_LABEL_MOTION =
  "transition-[max-width,opacity] duration-300 ease-sidebar motion-reduce:transition-none";

/** Opacity only — the two glyphs that cross-fade inside the toggle. */
export const SIDEBAR_FADE_MOTION =
  "transition-opacity duration-300 ease-sidebar motion-reduce:transition-none";

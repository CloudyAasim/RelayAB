/**
 * src/lib/docs/thinking.ts
 *
 * Which shape a model's thinking actually takes, for the catalogue's detail row.
 *
 * The row used to read `reasoningLevels.length` and nothing else, and print
 * "not declared" whenever the list was empty. That answer is true of exactly one
 * of the three situations an empty list can mean, and it was being given for all
 * of them — including the two that describe models which visibly think on every
 * reply. A model that always reasons and a model with an on/off switch but no
 * gears were both told they had declared no thinking levels, which is the one
 * thing the reader could watch disprove by using them.
 *
 * So the empty list is unpacked here, and the two booleans that were already on
 * the model do the work. The wording stays in the component, where the docs
 * index generator can see it as literals; this returns the decision.
 */
import type { CatalogModel } from "./catalog";

export type ThinkingShape =
  /** Takes gear-shifted levels; the reader picks one. */
  | "levels"
  /** A switch and no gears — `thinking: adaptive | disabled`, no effort field. */
  | "switchOnly"
  /** Reasons every time and cannot be told not to. */
  | "alwaysOn"
  /** Nobody has said anything about this model's thinking. */
  | "undeclared";

/**
 * The narrow slice this reads, so a caller can pass a fixture without building a
 * whole catalogue model.
 */
export type ThinkingFields = Pick<
  CatalogModel,
  "reasoningLevels" | "reasoningEffortSupported" | "thinkingSwitchSupported"
>;

export function thinkingShape(m: ThinkingFields): ThinkingShape {
  // A populated list is the vendor's own words and outranks everything else: a
  // model can have levels and still be impossible to switch off.
  if (m.reasoningLevels.length > 0) return "levels";
  // Only an explicit `false` is a claim somebody made about the vendor. `null`
  // means nobody has said, and must not be read as "this model cannot think" —
  // that mistake is what greyed out every reasoning control on upgrade day.
  if (m.reasoningEffortSupported === false) {
    return m.thinkingSwitchSupported === true ? "switchOnly" : "alwaysOn";
  }
  return "undeclared";
}

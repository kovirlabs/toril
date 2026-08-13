// Drag-to-resize for the side panes.
//
// Split the way the rest of the project splits things (§8): the geometry is a
// pure function gated in `tests/resizer.test.ts`, and the DOM binding below it
// is a thin shell that only translates pointer events into calls. The subtle
// behaviour — which direction widens, when a drag becomes a collapse — lives in
// the pure half where it can be tested without a window.

import { PANE_LIMITS, clampWidth } from "./panes";

/** Which side of the window the pane sits on. Decides the sign of the drag. */
export type ResizeEdge = "left" | "right";

export type DragOutcome = { kind: "width"; width: number } | { kind: "collapse" };

/**
 * How far past its minimum a pane must be dragged before the drag is read as
 * "close this", rather than "make it as small as it goes".
 *
 * Without this, a pane can only be closed via its toggle, and dragging it to the
 * edge just parks it at the minimum — which feels broken, because the pointer
 * keeps moving and nothing keeps happening.
 */
export const COLLAPSE_MARGIN = 56;

/** Keyboard resize step for the handle's arrow keys. */
export const NUDGE_STEP = 16;

export interface DragInput {
  edge: ResizeEdge;
  /** Pane width when the drag began. */
  startWidth: number;
  /** Pointer movement along x since the drag began. */
  deltaX: number;
  limits: { min: number; max: number; preferred: number };
  viewportWidth: number;
  /** Width of the opposite pane, so a drag cannot squeeze the editor out. */
  reserved?: number;
}

/**
 * Translate a drag into either a new width or a collapse.
 *
 * A left-hand pane grows as the pointer moves right; a right-hand pane grows as
 * it moves left. Getting that sign wrong is the classic resizer bug, and it is
 * exactly the kind of thing that is obvious in a test and invisible in review.
 */
export function resolveDrag(input: DragInput): DragOutcome {
  const { edge, startWidth, deltaX, limits, viewportWidth, reserved = 0 } = input;
  const raw = edge === "left" ? startWidth + deltaX : startWidth - deltaX;

  if (raw < limits.min - COLLAPSE_MARGIN) return { kind: "collapse" };
  return { kind: "width", width: clampWidth(raw, limits, viewportWidth, reserved) };
}

/**
 * Keyboard resizing from the handle. Returns a width only — arrow keys never
 * collapse, because an invisible one-keystroke-away collapse is a surprise; the
 * pane's own toggle is the discoverable way to close it.
 */
export function nudgeWidth(
  edge: ResizeEdge,
  width: number,
  key: "ArrowLeft" | "ArrowRight",
  limits: { min: number; max: number; preferred: number },
  viewportWidth: number,
  reserved = 0,
): number {
  const towardsWider = edge === "left" ? key === "ArrowRight" : key === "ArrowLeft";
  const next = width + (towardsWider ? NUDGE_STEP : -NUDGE_STEP);
  return clampWidth(next, limits, viewportWidth, reserved);
}

export interface ResizerHooks {
  /** Current width of the pane, read when a drag starts. */
  currentWidth: () => number;
  /** Width of the opposite pane right now, if it is on screen. */
  reservedWidth: () => number;
  onWidth: (width: number) => void;
  onCollapse: () => void;
  /** Called once when a drag ends, so the caller can persist. */
  onCommit: () => void;
}

/**
 * Bind a handle element. Uses pointer capture so the drag survives the pointer
 * leaving the 6px handle — without it, any drag faster than the render loop
 * drops on the first frame.
 */
export function attachResizer(
  handle: HTMLElement,
  edge: ResizeEdge,
  limits: { min: number; max: number; preferred: number },
  hooks: ResizerHooks,
): () => void {
  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const limitsFor = () => ({
    limits,
    viewportWidth: window.innerWidth,
    reserved: hooks.reservedWidth(),
  });

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startWidth = hooks.currentWidth();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "true";
    // Suppress the text selection a horizontal drag would otherwise start in
    // the editor next door.
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const outcome = resolveDrag({ edge, startWidth, deltaX: e.clientX - startX, ...limitsFor() });
    if (outcome.kind === "collapse") hooks.onCollapse();
    else hooks.onWidth(outcome.width);
  };

  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    delete handle.dataset.dragging;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    hooks.onCommit();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const { viewportWidth, reserved } = limitsFor();
    hooks.onWidth(nudgeWidth(edge, hooks.currentWidth(), e.key, limits, viewportWidth, reserved));
    hooks.onCommit();
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("keydown", onKeyDown);
  // Double-click a handle to restore the default width — the standard escape
  // hatch when a pane has been dragged somewhere unhelpful.
  const onDoubleClick = () => {
    hooks.onWidth(limits.preferred);
    hooks.onCommit();
  };
  handle.addEventListener("dblclick", onDoubleClick);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
    handle.removeEventListener("keydown", onKeyDown);
    handle.removeEventListener("dblclick", onDoubleClick);
  };
}

/**
 * Give a handle declared in the markup the a11y contract a separator needs.
 *
 * The elements live in app.html rather than being built here, so the document
 * structure stays readable in one place; this only adds the roles a plain div
 * cannot carry on its own.
 */
export function initResizeHandle(handle: HTMLElement, label: string): void {
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", label);
  handle.tabIndex = 0;
}

/** Keep the separator's reported value in step with the pane it controls. */
export function syncHandleValue(
  handle: HTMLElement,
  width: number,
  limits: { min: number; max: number } = PANE_LIMITS.sidebar,
): void {
  handle.setAttribute("aria-valuenow", String(Math.round(width)));
  handle.setAttribute("aria-valuemin", String(limits.min));
  handle.setAttribute("aria-valuemax", String(limits.max));
}

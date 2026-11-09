// Styled tooltips (#43), replacing native `title=` (ADR 0002).
//
//   <button class="icon-btn" aria-label="Refresh" use:tooltip>…</button>   text = the aria-label
//   <span use:tooltip={node.path}>…</span>                                  text = the argument
//   <button use:tooltip={tooltip ?? null}>                                  null or "" = no tooltip
//   <div use:tooltip={() => (cut() ? text : null)}>                         asked each time it would show
//
// (An undefined argument is the same as none, so a component forwarding an
// optional prop passes `?? null` to avoid showing its aria-label.)
//
// The action only attaches listeners; one shared tooltip element
// (TooltipHost.svelte, mounted once in App) shows the text for whichever
// element is hovered or keyboard-focused. When the text differs from the
// element's aria-label, the element points `aria-describedby` at the tooltip
// while it's shown, so assistive tech reads it as the description. Icon-only
// buttons need an `aria-label` (their accessible name); the tooltip repeats it.

/** Hover/focus time before a tooltip appears. */
export const TOOLTIP_DELAY = 400;
/** Moving to another trigger within this long of a tooltip hiding shows the next one at once. */
const WARM_FOR = 300;

export const TOOLTIP_ID = "app-tooltip";

class TooltipState {
  /** The element whose tooltip is pending or shown. */
  anchor = $state<HTMLElement | null>(null);
  text = $state("");
  visible = $state(false);
}

export const tip = new TooltipState();

let timer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;

function describe(el: HTMLElement, on: boolean) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== TOOLTIP_ID);
  if (on) ids.push(TOOLTIP_ID);
  if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

/** Sets the text for `el` (the anchor), describing it when the text isn't its name. */
function setText(el: HTMLElement, text: string) {
  tip.text = text;
  describe(el, text !== el.getAttribute("aria-label"));
}

function show(el: HTMLElement, text: string) {
  if (tip.anchor && tip.anchor !== el) hideTooltip();
  clearTimeout(timer);
  tip.anchor = el;
  setText(el, text);
  if (tip.visible) return;
  const reveal = () => (tip.visible = true);
  if (performance.now() - hiddenAt < WARM_FOR) reveal();
  else timer = setTimeout(reveal, TOOLTIP_DELAY);
}

/**
 * Hides the tooltip (or cancels a pending one). `warm`: a tooltip shown right
 * after this one appears without the delay (pointer moving along a toolbar);
 * off for keys, so arrowing through a list doesn't flash one per row.
 */
export function hideTooltip(warm = true) {
  clearTimeout(timer);
  if (tip.visible && warm) hiddenAt = performance.now();
  if (tip.anchor) describe(tip.anchor, false);
  tip.anchor = null;
  tip.visible = false;
}

/** The text, or a function that gives it when the tooltip is about to show (e.g. only while the text is cut off). */
export type TooltipText = string | null | (() => string | null);

/** `use:tooltip` / `use:tooltip={text}`. No text and no aria-label means no tooltip. */
export function tooltip(node: HTMLElement, text?: TooltipText) {
  let current = text;
  // After a click, wait for the pointer to leave before showing it again (as native tooltips do).
  let clicked = false;
  const textNow = () => (current === undefined ? (node.getAttribute("aria-label") ?? "") : ((typeof current === "function" ? current() : current) ?? ""));
  const start = () => {
    const t = textNow();
    if (t) show(node, t);
  };
  const stop = () => {
    if (tip.anchor === node) hideTooltip();
  };

  const onEnter = (e: PointerEvent) => {
    if (e.pointerType !== "touch" && !clicked) start();
  };
  const onLeave = () => {
    clicked = false;
    stop();
  };
  const onDown = () => {
    clicked = true;
    stop();
  };
  // Keyboard focus only: a click also focuses (and text inputs match
  // :focus-visible even then), and shouldn't pop a tooltip.
  const onFocus = () => {
    if (!clicked && node.matches(":focus-visible")) start();
  };
  // A focused element Svelte removes blurs while the block removing it is still
  // updating, where changing state is forbidden: hide once that's done.
  const onBlur = () => queueMicrotask(stop);

  node.addEventListener("pointerenter", onEnter);
  node.addEventListener("pointerleave", onLeave);
  node.addEventListener("pointerdown", onDown);
  node.addEventListener("focus", onFocus);
  node.addEventListener("blur", onBlur);
  return {
    update(next?: TooltipText) {
      current = next;
      if (tip.anchor !== node) return;
      const t = textNow();
      if (t) setText(node, t);
      else stop();
    },
    destroy() {
      node.removeEventListener("pointerenter", onEnter);
      node.removeEventListener("pointerleave", onLeave);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", onBlur);
      stop();
    },
  };
}

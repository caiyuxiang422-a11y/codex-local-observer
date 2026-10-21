import { useEffect, type RefObject } from "react";

/** Keep keyboard navigation aligned with the dialog's modal semantics. */
export function useDialogFocus(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open || !panel.current) return;
    const dialog = panel.current;
    const returnTarget = trigger.current ?? document.activeElement as HTMLElement | null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    )].filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
    const first = () => focusable()[0] ?? dialog;
    first().focus({ preventScroll: true });
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) first().focus({ preventScroll: true });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const last = elements[elements.length - 1];
      const target = event.shiftKey ? last : elements[0];
      if (!elements.length || !dialog.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === elements[0]) ||
        (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (target ?? dialog).focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
      // React removes inert from the background in the same commit.
      queueMicrotask(() => {
        if (returnTarget?.isConnected && !returnTarget.closest('[inert]')) returnTarget.focus({ preventScroll: true });
      });
    };
  }, [open, panel, trigger]);
}

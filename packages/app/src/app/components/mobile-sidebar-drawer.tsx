import { Show, createEffect, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

type MobileSidebarDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: JSX.Element;
};

export default function MobileSidebarDrawer(props: MobileSidebarDrawerProps) {
  createEffect(() => {
    if (!props.open || typeof window === "undefined" || typeof document === "undefined") return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    });
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[45] md:hidden">
        <button
          type="button"
          class="absolute inset-0 bg-gray-1/60 backdrop-blur-sm"
          onClick={props.onClose}
          aria-label="Close sidebar"
        />
        <div class="absolute inset-y-0 right-0 w-[min(360px,calc(100vw-20px))] max-w-full border-l border-dls-border bg-dls-sidebar p-3 shadow-2xl">
          {props.children}
        </div>
      </div>
    </Show>
  );
}

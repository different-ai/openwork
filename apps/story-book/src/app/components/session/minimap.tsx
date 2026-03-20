import { For, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { MessageWithParts } from "../../types";

export type MinimapProps = {
  containerRef: () => HTMLDivElement | undefined;
  messages: MessageWithParts[];
};

export default function Minimap(props: MinimapProps) {
  const [lines, setLines] = createSignal<{ id: string; role: "user" | "assistant"; top: number; height: number }[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);

  let rafId: number | null = null;

  const update = () => {
    const container = props.containerRef();
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    
    // Find all message groups (bubbles)
    // We assume MessageList renders them with data-message-id
    const elements = Array.from(container.querySelectorAll('[data-message-role]'));
    
    const nextLines = elements.map(el => {
      const rect = el.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top + scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      
      // Map content position (0 to scrollHeight) to viewport position (0 to clientHeight)
      const mapTop = (relativeTop / scrollHeight) * clientHeight;
      
      return {
        id: el.getAttribute('data-message-id') || "",
        role: el.getAttribute('data-message-role') as "user" | "assistant",
        top: mapTop,
        height: 2 
      };
    });
    
    setLines(nextLines);

    // Update active message based on center
    const center = containerRect.top + containerRect.height / 2;
    let closestId = null;
    let minDist = Infinity;
    
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const dist = Math.abs((rect.top + rect.height / 2) - center);
      if (dist < minDist) {
        minDist = dist;
        closestId = el.getAttribute('data-message-id');
      }
    });
    setActiveId(closestId);
  };

  const scheduleUpdate = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      update();
      rafId = null;
    });
  };

  createEffect(() => {
    props.messages.length;
    scheduleUpdate();
  });

  createEffect(() => {
    const container = props.containerRef();
    if (!container) return;

    container.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);

    onCleanup(() => {
      container.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    });
  });

  return (
    <div class="hidden lg:flex w-6 bg-gray-1/50 border-l border-gray-3 flex-col items-center justify-start relative group/rail z-10 overflow-hidden py-2 h-full backdrop-blur-sm">
      <For each={lines()}>
        {(line, idx) => {
          const isActive = () => line.id === activeId();
          const isUser = line.role === "user";
          
          return (
            <button
              type="button"
              aria-label={`${isUser ? "User" : "Agent"} message ${idx() + 1}`}
              aria-current={isActive() ? "true" : undefined}
              class={`absolute left-1/2 -translate-x-1/2 rounded-full transition-all duration-300 ease-out cursor-pointer appearance-none border-none p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-12/70
                ${
                  isActive()
                    ? "w-4 h-1.5 opacity-100 z-20 bg-gray-12 shadow-sm"
                    : `w-2 h-1 ${isUser ? "bg-gray-11 opacity-60" : "bg-gray-6 opacity-40"} hover:w-3 hover:opacity-100`
                }
              `}
              style={{
                top: `${line.top}px`,
              }}
              title={isUser ? "User" : "Agent"}
              onClick={(e) => {
                e.stopPropagation();
                const container = props.containerRef();
                const el = container?.querySelector(`[data-message-id="${line.id}"]`);
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              <span aria-hidden="true" class="absolute -inset-x-2 -inset-y-1" />
            </button>
          );
        }}
      </For>
    </div>
  );
}

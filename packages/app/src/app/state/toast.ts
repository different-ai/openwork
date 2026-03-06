import { createSignal } from "solid-js";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);

export function useToasts() {
  const addToast = (message: string, type: ToastType = "info", duration = 3000) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = { id, message, type, duration };
    
    setToasts((prev) => [...prev, newToast]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return {
    toasts,
    addToast,
    removeToast,
    success: (msg: string, dur?: number) => addToast(msg, "success", dur),
    error: (msg: string, dur?: number) => addToast(msg, "error", dur),
    info: (msg: string, dur?: number) => addToast(msg, "info", dur),
    warning: (msg: string, dur?: number) => addToast(msg, "warning", dur),
  };
}

export const toast = {
  success: (msg: string, dur?: number) => useToasts().success(msg, dur),
  error: (msg: string, dur?: number) => useToasts().error(msg, dur),
  info: (msg: string, dur?: number) => useToasts().info(msg, dur),
  warning: (msg: string, dur?: number) => useToasts().warning(msg, dur),
};

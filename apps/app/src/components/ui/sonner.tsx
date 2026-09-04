import * as React from "react"
import { Toaster as Sonner, toast as sonnerToast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, type LucideIcon, XIcon } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function useTheme() {
  return React.useSyncExternalStore(
    subscribeToTheme,
    getResolvedThemeMode,
    getResolvedThemeMode,
  )
}

const toasterStyle: React.CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={toasterStyle}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

type ToastType = "default" | "success" | "info" | "warning" | "error"

interface ToastAction {
  label: React.ReactNode
  onClick: () => void
}

interface ToastOptions {
  id?: string | number
  description?: React.ReactNode
  action?: ToastAction
  cancel?: ToastAction
  duration?: number
}

const TOAST_ICONS: Record<Exclude<ToastType, "default">, LucideIcon> = {
  success: CircleCheckIcon,
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: OctagonXIcon,
}

const toastTile = cva(
  "mt-0.5 flex shrink-0 items-center justify-center",
  {
    variants: {
      type: {
        default: "text-sky-11",
        success: "text-emerald-11",
        info: "text-sky-11",
        warning: "text-amber-11",
        error: "text-red-11",
      },
      size: {
        default: "size-10 rounded-2xl border",
        sm: "size-4",
      },
    },
    compoundVariants: [
      { size: "default", type: "default", className: "border-sky-6/40 bg-sky-4/80" },
      { size: "default", type: "success", className: "border-emerald-6/40 bg-emerald-4/80" },
      { size: "default", type: "info", className: "border-sky-6/40 bg-sky-4/80" },
      { size: "default", type: "warning", className: "border-amber-6/40 bg-amber-4/80" },
      { size: "default", type: "error", className: "border-red-6/40 bg-red-4/80" },
    ],
    defaultVariants: { type: "default", size: "default" },
  },
)

interface ToastIconProps extends VariantProps<typeof toastTile> {
  className?: string
}

function ToastIcon({ className, type, size }: ToastIconProps) {
  if (!type || type === "default") {
    return null;
  }

  const Icon = TOAST_ICONS[type]

  return (
    <div className={cn(toastTile({ type, size, className }))}>
      <Icon className="size-4" />
    </div>
  )
}

interface ToastCardProps {
  id: string | number
  type: ToastType
  title: React.ReactNode
  description?: React.ReactNode
  action?: ToastAction
  cancel?: ToastAction
  notification?: boolean
}

function ToastCard({ id, type, title, description, action, cancel, notification }: ToastCardProps) {
  if (notification) {
    return (
      <div className={cn("flex w-full gap-3 rounded-2xl border border-border bg-popover/95 backdrop-blur-sm p-4 text-popover-foreground shadow-md md:max-w-sm ring-1 ring-popover-border/20 items-center")}>
        <ToastIcon type={type} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{title}</p>
            <Button variant="ghost" size="sm" onClick={() => sonnerToast.dismiss(id)}>
              <XIcon className="size-4" />
            </Button>
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex w-full items-start gap-3 rounded-2xl border border-border bg-popover/95 backdrop-blur-sm p-4 text-popover-foreground shadow-md md:max-w-sm ring-1 ring-popover-border/20")}>
      <ToastIcon type={type} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
         <p className="text-sm font-medium">{title}</p>
         <Button variant="ghost" size="sm" onClick={() => sonnerToast.dismiss(id)}>
          <XIcon className="size-4" />
          </Button>
        </div>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {action || cancel ? (
          <div className="mt-2 flex gap-2">
            {action ? (
              <Button
                size="sm"
                onClick={() => {
                  action.onClick()
                  sonnerToast.dismiss(id)
                }}
              >
                {action.label}
              </Button>
            ) : null}
            {cancel ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  cancel.onClick()
                  sonnerToast.dismiss(id)
                }}
              >
                {cancel.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

interface UndoToastOptions {
  id?: string | number
  duration?: number
  /** Glyph for the action that was just taken, e.g. an archive box. */
  icon?: LucideIcon
  /** Reverses the action; the toast dismisses as soon as it is chosen. */
  undo: ToastAction
  /** Optional secondary action that leaves the change in place, e.g. "View". */
  view?: ToastAction
  closeLabel?: string
}

/** Reversible actions stay quiet for long enough to change your mind. */
const UNDO_TOAST_DURATION_MS = 10_000

interface UndoToastCardProps extends Omit<UndoToastOptions, "id" | "duration"> {
  id: string | number
  title: React.ReactNode
}

/**
 * One-line confirmation for a reversible action, dropped in from the top of
 * the window: icon, what happened, then "View" / "Undo" / close. The wrapper
 * spans sonner's toast width so the pill itself can hug its content and stay
 * centered under the title bar.
 */
function UndoToastCard({ id, title, icon: Icon, undo, view, closeLabel }: UndoToastCardProps) {
  return (
    <div className="flex w-[var(--width)] max-w-full justify-center">
      <div
        data-undo-toast
        className="flex w-fit max-w-full items-center gap-3 rounded-2xl border border-border bg-popover/95 py-1.5 pl-4 pr-1.5 text-popover-foreground shadow-md ring-1 ring-popover-border/20 backdrop-blur-sm"
      >
        {Icon ? <Icon className="size-4 shrink-0" /> : null}
        <p className="min-w-0 truncate text-sm font-medium">{title}</p>
        <div className="flex shrink-0 items-center gap-1">
          {view ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                view.onClick()
                sonnerToast.dismiss(id)
              }}
            >
              {view.label}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              undo.onClick()
              sonnerToast.dismiss(id)
            }}
          >
            {undo.label}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={closeLabel} onClick={() => sonnerToast.dismiss(id)}>
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function showUndoToast(message: React.ReactNode, options: UndoToastOptions) {
  return sonnerToast.custom(
    (id) => (
      <UndoToastCard
        id={id}
        title={message}
        icon={options.icon}
        undo={options.undo}
        view={options.view}
        closeLabel={options.closeLabel}
      />
    ),
    {
      id: options.id,
      duration: options.duration ?? UNDO_TOAST_DURATION_MS,
      position: "top-center",
    },
  )
}

function showToast(type: ToastType, message: React.ReactNode, options?: ToastOptions) {
  const notification = options?.action === undefined && options?.cancel === undefined;

  return sonnerToast.custom(
    (id) => (
      <ToastCard
        id={id}
        type={type}
        title={message}
        description={options?.description}
        action={options?.action}
        cancel={options?.cancel}
        notification={notification}
      />
    ),
    {
      id: options?.id,
      duration: options?.duration,
      description: undefined,
      action: undefined,
      cancel: undefined,
      position: notification ? "top-center" : "bottom-right",
    },
  )
}

const toast = Object.assign(
  (message: React.ReactNode, options?: ToastOptions) => showToast("default", message, options),
  {
    success: (message: React.ReactNode, options?: ToastOptions) => showToast("success", message, options),
    info: (message: React.ReactNode, options?: ToastOptions) => showToast("info", message, options),
    warning: (message: React.ReactNode, options?: ToastOptions) => showToast("warning", message, options),
    error: (message: React.ReactNode, options?: ToastOptions) => showToast("error", message, options),
    undo: (message: React.ReactNode, options: UndoToastOptions) => showUndoToast(message, options),
    dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  },
)

export { Toaster, toast }

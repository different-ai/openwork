"use client";

import type { ButtonHTMLAttributes, ElementType } from "react";

// ─── Variant / size tokens ────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "destructive";
export type ButtonSize = "md" | "sm";

const variantClasses: Record<ButtonVariant, string> = {
    primary: "bg-[#0f172a] text-white hover:bg-[#111c33]",
    secondary:
        "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900",
    destructive:
        "border border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300",
};

// md is sized to match the Shared Workspaces reference buttons (px-5 py-2.5 ≈ h-10)
const sizeClasses: Record<ButtonSize, string> = {
    md: "h-10 px-5 text-[13px] gap-2",
    sm: "h-8 px-3.5 text-[12px] gap-1.5",
};

// ─── buttonVariants helper (for <Link> / <a> elements) ───────────────────────

/**
 * Returns the className string for button styles.
 * Use this on <Link> and <a> elements that should look like buttons.
 */
export function buttonVariants({
    variant = "primary",
    size = "md",
    className = "",
}: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
} = {}): string {
    return [
        "inline-flex items-center justify-center rounded-full font-medium transition-colors",
        variantClasses[variant],
        sizeClasses[size],
        className,
    ]
        .filter(Boolean)
        .join(" ");
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner({ px }: { px: number }) {
    return (
        <svg
            aria-hidden="true"
            className="animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            width={px}
            height={px}
        >
            <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
            />
            <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
        </svg>
    );
}

// ─── DenButton ────────────────────────────────────────────────────────────────

export type DenButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /**
     * Lucide icon component rendered on the left.
     * In loading state the icon is replaced by a spinner.
     */
    icon?: ElementType<{
        size?: number;
        className?: string;
        strokeWidth?: number;
    }>;
    /**
     * Shows a spinner and forces the button into a disabled state.
     * - With icon: spinner replaces the icon; text stays visible.
     * - Without icon: text becomes invisible (preserving button width) and a
     *   spinner appears centered over it.
     */
    loading?: boolean;
};

export function DenButton({
    variant = "primary",
    size = "md",
    icon: Icon,
    loading = false,
    disabled = false,
    children,
    className,
    ...rest
}: DenButtonProps) {
    const isDisabled = disabled || loading;
    const iconPx = size === "sm" ? 13 : 15;
    const hasText = children !== null && children !== undefined;
    // No-icon loading: hide text but keep its width, overlay centered spinner
    const noIconLoading = loading && !Icon;

    return (
        <button
            {...rest}
            type={rest.type ?? "button"}
            disabled={isDisabled}
            className={[
                "relative flex flex-row gap-2 items-center justify-center rounded-full font-medium transition-colors",
                variantClasses[variant],
                sizeClasses[size],
                isDisabled ? "cursor-not-allowed opacity-70" : "",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {/* Leading icon slot ─ shows icon normally, or spinner when loading */}
            {Icon && !loading && (
                <Icon size={iconPx} strokeWidth={1.75} aria-hidden="true" />
            )}
            {Icon && loading && <Spinner px={iconPx} />}

            {/* Text — invisible (not removed) when in no-icon loading state */}
            {hasText && (
                <div
                    className={[
                        noIconLoading ? "invisible" : undefined,
                        "flex flex-row gap-2 items-center",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                >
                    {children}
                </div>
            )}

            {/* Centered overlay spinner when there is no icon */}
            {noIconLoading && (
                <span className="absolute inset-0 flex items-center justify-center">
                    <Spinner px={iconPx} />
                </span>
            )}
        </button>
    );
}

"use client";

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ElementType, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost" | "plain";
export type ButtonSize = "md" | "sm" | "xs" | "compact" | "inline";

const variantClasses: Record<ButtonVariant, string> = {
    primary: "bg-[#0f172a] text-white hover:bg-[#111c33]",
    secondary:
        "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900",
    destructive:
        "border border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300",
    ghost: "text-gray-500 hover:text-gray-900",
    plain: "text-gray-900 hover:text-gray-600",
};

const sizeClasses: Record<ButtonSize, string> = {
    md: "h-10 px-5 text-[13px] gap-2",
    sm: "h-8 px-3.5 text-[12px] gap-1.5",
    xs: "h-8 px-3 text-[12px]",
    compact: "h-8 px-3 text-[13px] leading-4.5 gap-1.5",
    inline: "h-8 px-0 text-xs leading-4 gap-1.5",
};

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
        "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors",
        variantClasses[variant],
        sizeClasses[size],
        className,
    ]
        .filter(Boolean)
        .join(" ");
}

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

type DenButtonBaseProps = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    icon?: ElementType<{
        size?: number;
        className?: string;
        strokeWidth?: number;
    }>;
    loading?: boolean;
};

type DenButtonAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & DenButtonBaseProps & {
    href: string;
};

type DenButtonNativeProps = ButtonHTMLAttributes<HTMLButtonElement> & DenButtonBaseProps & {
    href?: undefined;
};

export type DenButtonProps = DenButtonAnchorProps | DenButtonNativeProps;

function DenButtonContent({
    icon: Icon,
    loading,
    size,
    children,
}: {
    icon?: ElementType<{
        size?: number;
        className?: string;
        strokeWidth?: number;
    }>;
    loading: boolean;
    size: ButtonSize;
    children?: ReactNode;
}) {
    const iconPx = size === "sm" ? 13 : 15;
    const hasText = children !== null && children !== undefined;
    const noIconLoading = loading && !Icon;

    return (
        <>
            {Icon && !loading && (
                <Icon size={iconPx} strokeWidth={1.75} aria-hidden="true" />
            )}
            {Icon && loading && <Spinner px={iconPx} />}

            {hasText && (
                <div
                    className={[
                        noIconLoading ? "invisible" : undefined,
                        "flex min-w-0 flex-row gap-2 items-center",
                    ]
                        .filter(Boolean)
                        .join(" ")}
                >
                    {children}
                </div>
            )}

            {noIconLoading && (
                <span className="absolute inset-0 flex items-center justify-center">
                    <Spinner px={iconPx} />
                </span>
            )}
        </>
    );
}

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
    const classNames = [
        "relative flex flex-row gap-2 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors",
        variantClasses[variant],
        sizeClasses[size],
        isDisabled ? "cursor-not-allowed opacity-70" : "",
        className ?? "",
    ]
        .filter(Boolean)
        .join(" ");

    if (rest.href !== undefined) {
        return (
            <a
                {...rest}
                aria-disabled={isDisabled || undefined}
                className={classNames}
            >
                <DenButtonContent icon={Icon} loading={loading} size={size}>{children}</DenButtonContent>
            </a>
        );
    }

    return (
        <button
            {...rest}
            type={rest.type ?? "button"}
            disabled={isDisabled}
            className={classNames}
        >
            <DenButtonContent icon={Icon} loading={loading} size={size}>{children}</DenButtonContent>
        </button>
    );
}

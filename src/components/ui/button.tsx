import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

const variants = {
  primary:
    "bg-brand text-brand-ink hover:brightness-110 disabled:hover:brightness-100",
  secondary:
    "bg-surface-2 text-ink border border-line hover:border-brand/60 hover:bg-surface",
  ghost: "text-muted hover:text-ink hover:bg-surface-2",
  danger: "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
} as const;

const sizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  icon: "h-8 w-8 justify-center",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center gap-2 rounded-lg font-medium transition focus-ring disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});

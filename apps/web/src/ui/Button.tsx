import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Buttons. Exactly one primary per action group; ghost for quiet context
 * actions; danger only for destructive operations (danger-ghost when the
 * destructive action sits among neutral ones).
 */

type BtnKind = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost" | "link";

const KIND_CLASS: Record<BtnKind, string> = {
  primary: "pv-btn-primary",
  secondary: "",
  ghost: "pv-btn-ghost",
  danger: "pv-btn-danger",
  "danger-ghost": "pv-btn-danger-ghost",
  link: "pv-btn-link",
};

export function Btn({
  kind = "secondary",
  size,
  loading,
  children,
  className,
  ...rest
}: {
  kind?: BtnKind;
  size?: "sm";
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `pv-btn${KIND_CLASS[kind] ? ` ${KIND_CLASS[kind]}` : ""}${size === "sm" ? " pv-btn-sm" : ""}${className ? ` ${className}` : ""}`;
  return (
    <button className={cls} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner size={size === "sm" ? 11 : 13} />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  size = "sm",
  children,
  className,
  ...rest
}: {
  label: string;
  size?: "sm" | "md";
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `pv-btn pv-btn-ghost pv-btn-icon${size === "sm" ? " pv-btn-sm" : ""}${className ? ` ${className}` : ""}`;
  return (
    <button className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** Minimal inline spinner — no dependency, honors reduced motion via CSS. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

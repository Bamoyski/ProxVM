import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Search as SearchIcon } from "lucide-react";

/**
 * Form primitives. Field wires label/description/error to the control with
 * proper ids and aria-invalid so validation is announced, not just colored.
 *
 * Children can be a render function (full control over ids) or a subtree —
 * in the latter case the first form control inside it receives the generated
 * id and the describedby/aria-invalid wiring automatically. Controls that
 * already carry an id keep it.
 */

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children:
    | ((ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode)
    | ReactNode;
  htmlFor?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;

  const ariaProps = {
    "aria-describedby": describedBy,
    "aria-invalid": error ? (true as const) : undefined,
  };

  let control: ReactNode;
  if (typeof children === "function") {
    control = (children as (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode)({
      id,
      describedBy,
      invalid: !!error,
    });
  } else {
    // Attach the id to the first control in the subtree.
    let assigned = false;
    const wire = (node: ReactNode): ReactNode =>
      Children.map(node, (child) => {
        if (!isValidElement(child)) return child;
        const props = child.props as {
          id?: string;
          "aria-describedby"?: string;
          "aria-invalid"?: boolean;
          children?: ReactNode;
        };
        const type = child.type as unknown;
        const isControl =
          type === "input" || type === "select" || type === "textarea";
        const isComponent = typeof type === "function";
        if (isControl || isComponent) {
          if (assigned) return child;
          assigned = true;
          return cloneElement(child, {
            id: props.id ?? id,
            "aria-describedby": props["aria-describedby"] ?? ariaProps["aria-describedby"],
            "aria-invalid": props["aria-invalid"] ?? ariaProps["aria-invalid"],
          } as never);
        }
        if (props.children) {
          return cloneElement(child, {}, wire(props.children));
        }
        return child;
      });
    control = wire(children);
  }

  return (
    <div className="pv-field">
      <label className="pv-label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true" style={{ color: "var(--pv-err)", marginLeft: 3 }}>*</span>}
      </label>
      {control}
      {hint && (
        <div className="pv-hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="pv-field-err" id={errId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function Input({
  invalid,
  small,
  autoWidth,
  className,
  ...rest
}: { invalid?: boolean; small?: boolean; autoWidth?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const cls = `pv-input${small ? " pv-input-sm" : ""}${autoWidth ? " pv-input-auto" : ""}${className ? ` ${className}` : ""}`;
  return <input className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

/** Toolbar search box: icon + input as one control. */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <span className="pv-search">
      <SearchIcon size={13} className="pv-search-ico" aria-hidden="true" />
      <input
        className="pv-input"
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
    </span>
  );
}

export function Textarea({
  invalid,
  className,
  ...rest
}: { invalid?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const cls = `pv-textarea${className ? ` ${className}` : ""}`;
  return <textarea className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

export function Select({
  className,
  autoWidth,
  small,
  ...rest
}: { autoWidth?: boolean; small?: boolean } & SelectHTMLAttributes<HTMLSelectElement>) {
  const cls = `pv-select${autoWidth ? " pv-input-auto" : ""}${small ? " pv-input-sm" : ""}${className ? ` ${className}` : ""}`;
  return <select className={cls} {...rest} />;
}

export function Checkbox({
  label,
  className,
  ...rest
}: { label?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  if (!label) return <input type="checkbox" className={className} {...rest} />;
  return (
    <label className={`pv-checkrow${className ? ` ${className}` : ""}`}>
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="pv-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="pv-switch-track" aria-hidden="true" />
      <span className="pv-switch-thumb" aria-hidden="true" />
    </span>
  );
}

import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn("w-full min-w-[720px] border-collapse text-sm", className)}
        {...props}
      />
    </div>
  );
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} className={cn("divide-y divide-line/40", props.className)} />;
}

export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      {...props}
      className={cn(
        "border-b border-line text-left text-[11px] uppercase tracking-wide text-muted",
        props.className,
      )}
    />
  );
}

export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} className={cn("px-3 py-2 font-medium", props.className)} />;
}

export function Td(props: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={cn("px-3 py-2.5 align-middle", props.className)} />;
}

export function Tr(props: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...props}
      className={cn("border-b border-line/60 last:border-0 hover:bg-surface-2/60", props.className)}
    />
  );
}

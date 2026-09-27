import Link from "next/link";
import { cn } from "@/lib/utils";

interface Option {
  value: string;
  label: string;
}

interface Props {
  basePath: string;
  /** Query params to preserve (range/from/to/userId…). */
  params: Record<string, string | undefined>;
  /** Param this control drives (e.g. "dimension" or "metric"). */
  param: string;
  active: string;
  label: string;
  options: Option[];
}

/**
 * Segmented control rendered as plain links, so switching the view is a normal
 * navigation (and can be prefetched) without shipping client JS.
 */
export function UsageViewTabs({
  basePath,
  params,
  param,
  active,
  label,
  options,
}: Props) {
  const hrefFor = (value: string) => {
    const query = new URLSearchParams();
    for (const [key, val] of Object.entries({ ...params, [param]: value })) {
      if (val) query.set(key, val);
    }
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="inline-flex flex-wrap rounded-md border border-border p-0.5">
        {options.map((option) => (
          <Link
            key={option.value}
            href={hrefFor(option.value)}
            aria-current={active === option.value ? "true" : undefined}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors",
              active === option.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

import Link from "next/link";
import { cn } from "@/lib/utils";

interface Option {
  value: string;
  label: string;
}

type Scope = "all" | "key" | "model";

interface Props {
  basePath: string;
  /** Non-scope params to preserve (metric, group). */
  params: Record<string, string | undefined>;
  scope: Scope;
  keyId?: string;
  model?: string;
  keys: Option[];
  models: Option[];
  labels: {
    scope: string;
    all: string;
    key: string;
    model: string;
    keyPlaceholder: string;
    modelPlaceholder: string;
    apply: string;
  };
}

/**
 * "统计范围" control: chart the whole deployment/account, or narrow it to one
 * key or one model. The tabs are plain links; the entity picker is a GET form,
 * so both work without client JS and produce shareable URLs.
 */
export function UsageScopePicker({
  basePath,
  params,
  scope,
  keyId,
  model,
  keys,
  models,
  labels,
}: Props) {
  const hrefFor = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...next })) {
      if (value) query.set(key, value);
    }
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const tabs: Array<{ value: Scope; label: string }> = [
    { value: "all", label: labels.all },
    { value: "key", label: labels.key },
    { value: "model", label: labels.model },
  ];

  const hrefForTab = (value: Scope) => {
    if (value === "all") return hrefFor({ scope: "all", keyId: undefined, model: undefined });
    if (value === "key")
      return hrefFor({ scope: "key", model: undefined, keyId: keyId || keys[0]?.value });
    return hrefFor({ scope: "model", keyId: undefined, model: model || models[0]?.value });
  };

  const entityOptions = scope === "key" ? keys : models;
  const entityName = scope === "key" ? "keyId" : "model";
  const entityValue = scope === "key" ? keyId : model;
  const placeholder = scope === "key" ? labels.keyPlaceholder : labels.modelPlaceholder;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
      <span className="text-xs text-muted-foreground">{labels.scope}</span>
      <div className="inline-flex flex-wrap rounded-md border border-border p-0.5">
        {tabs.map((tab) => (
          <Link
            key={tab.value}
            href={hrefForTab(tab.value)}
            aria-current={scope === tab.value ? "true" : undefined}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors",
              scope === tab.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {(scope === "key" || scope === "model") && (
        <form method="get" action={basePath} className="flex flex-wrap items-center gap-2">
          {Object.entries(params).map(([key, value]) =>
            value ? <input key={key} type="hidden" name={key} value={value} /> : null,
          )}
          <input type="hidden" name="scope" value={scope} />
          <select
            name={entityName}
            defaultValue={entityValue ?? ""}
            className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            {!entityValue && <option value="">{placeholder}</option>}
            {entityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="h-8 rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
          >
            {labels.apply}
          </button>
        </form>
      )}
    </div>
  );
}

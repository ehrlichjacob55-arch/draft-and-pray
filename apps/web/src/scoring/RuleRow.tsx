import { POSITIONS } from "@dnp/domain";
import { btnSecondary, inputCls } from "../components/ui";
import {
  asRule,
  kindOf,
  perUnitExample,
  statLabel,
  unitOf,
  type RuleJson,
  type TierJson,
} from "./catalog";
import { NumberField } from "./fields";

const set = (rule: RuleJson, key: string, value: unknown): RuleJson => {
  const next = { ...rule };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

function TierEditor({
  rule,
  title,
  onChange,
}: {
  rule: RuleJson;
  title: string;
  onChange: (r: RuleJson) => void;
}) {
  const tiers = (Array.isArray(rule.tiers) ? rule.tiers : []).map(asRule) as TierJson[];
  const unit = kindOf(rule) === "distance_tiers" ? " yds" : "";
  const write = (next: TierJson[]) => onChange({ ...rule, tiers: next });
  const edit = (i: number, key: keyof TierJson, value: unknown) =>
    write(tiers.map((t, j) => (j === i ? (set(t as RuleJson, key, value) as TierJson) : t)));
  const add = () => {
    const last = tiers[tiers.length - 1];
    const lastMin = typeof last?.min === "number" ? last.min : 0;
    const max = typeof last?.max === "number" ? last.max : lastMin + 9;
    write([...tiers.slice(0, -1), { ...last, max }, { min: max + 1, points: 0 }]);
  };
  const remove = (i: number) => {
    const removed = tiers[i]!;
    const rest = tiers.filter((_, j) => j !== i).map((t) => ({ ...t }));
    if (i === rest.length) {
      // Removed the last band: the one before it becomes open-ended.
      const prev = rest[rest.length - 1];
      if (prev) delete prev.max;
    } else if (rest[i]) {
      // Removed a band in the middle (or first): the next one takes over its range.
      rest[i] = { ...rest[i], min: i === 0 ? 0 : removed.min };
    }
    write(rest);
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2 text-xs text-muted">
        <span>From{unit}</span>
        <span>To{unit}</span>
        <span>Points</span>
        <span />
      </div>
      {tiers.map((t, i) => {
        const isLast = i === tiers.length - 1;
        return (
          <div
            key={i}
            data-testid="tier-row"
            className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2"
          >
            <NumberField
              label={`${title} band ${i + 1} from`}
              className="w-full"
              value={t.min}
              onChange={(v) => edit(i, "min", v)}
            />
            {isLast && t.max === undefined ? (
              <span className="text-sm text-muted">and up</span>
            ) : (
              <NumberField
                label={`${title} band ${i + 1} to`}
                className="w-full"
                value={t.max}
                onChange={(v) => edit(i, "max", v)}
              />
            )}
            <NumberField
              label={`${title} band ${i + 1} points`}
              className="w-full"
              value={t.points}
              onChange={(v) => edit(i, "points", v)}
            />
            <button
              type="button"
              className={`${btnSecondary} px-2`}
              aria-label={`Remove ${title} band ${i + 1}`}
              disabled={tiers.length <= 1}
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button type="button" className={btnSecondary} onClick={add}>
        Add band
      </button>
    </div>
  );
}

/** One editable rule: fields follow its type; errors from validation show under it. */
export function RuleRow({
  rule,
  index,
  errors,
  onChange,
  onRemove,
}: {
  rule: RuleJson;
  index: number;
  errors: string[];
  onChange: (r: RuleJson) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(rule);
  const title = statLabel(rule.stat);
  const unit = unitOf(rule.stat);
  const positions = Array.isArray(rule.positions) ? (rule.positions as string[]) : [];
  const example = kind === "per_unit" ? perUnitExample(rule) : null;
  const invalid = errors.length > 0;
  return (
    <li
      data-testid={`rule-${index}`}
      className={`space-y-3 rounded border p-3 ${invalid ? "border-error" : "border-border"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted">{kind.replace("_", " ")}</p>
        </div>
        <button
          type="button"
          className={btnSecondary}
          aria-label={`Remove rule ${title}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      {(kind === "per_event" || kind === "per_unit" || kind === "bonus") && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {kind === "bonus" && <span>+</span>}
          <NumberField
            label={`${title} points`}
            value={rule.points}
            onChange={(v) => onChange(set(rule, "points", v))}
          />
          <span>pts</span>
          {kind === "per_event" && <span>each</span>}
          {kind === "per_unit" && (
            <>
              <span>per</span>
              <NumberField
                label={`${title} per`}
                value={rule.per}
                // Keep the key when cleared: its presence is what makes this a per-unit rule.
                onChange={(v) => onChange(set(rule, "per", v ?? ""))}
              />
              <span>{unit.trim() || "units"}</span>
            </>
          )}
          {kind === "bonus" && (
            <>
              <span>when at least</span>
              <NumberField
                label={`${title} at least`}
                value={rule.gte}
                onChange={(v) => onChange(set(rule, "gte", v ?? ""))}
              />
              {unit && <span>yds</span>}
            </>
          )}
        </div>
      )}

      {kind === "per_unit" && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rule.fractional === true}
              onChange={(e) =>
                onChange(set(rule, "fractional", e.target.checked ? true : undefined))
              }
            />
            Fractional (count partial units)
          </label>
          {example && (
            <p className="text-xs text-muted" data-testid="per-unit-example">
              Example: {example}
            </p>
          )}
        </div>
      )}

      {(kind === "tiers" || kind === "distance_tiers") && (
        <TierEditor rule={rule} title={title} onChange={onChange} />
      )}

      <fieldset className="text-sm">
        <legend className="text-xs text-muted">
          Applies to {positions.length ? positions.join(", ") : "all positions"}
        </legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {POSITIONS.map((p) => (
            <label key={p} className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={`${title} applies to ${p}`}
                checked={positions.includes(p)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? POSITIONS.filter((x) => x === p || positions.includes(x))
                    : positions.filter((x) => x !== p);
                  onChange(set(rule, "positions", next.length ? next : undefined));
                }}
              />
              {p}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-xs text-muted">
        Label in breakdowns (optional)
        <input
          className={`${inputCls} mt-1 text-sm`}
          aria-label={`${title} label`}
          value={typeof rule.label === "string" ? rule.label : ""}
          onChange={(e) =>
            onChange(set(rule, "label", e.target.value === "" ? undefined : e.target.value))
          }
        />
      </label>

      {invalid && (
        <ul className="space-y-1" aria-label={`Problems with ${title}`}>
          {errors.map((e, i) => (
            <li key={i} role="alert" className="text-sm text-error">
              {e}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

import { useId, useState } from "react";
import type { StatKey } from "@dnp/domain";
import { btnSecondary, inputCls } from "../components/ui";
import {
  KIND_LABELS,
  STAT_OPTIONS,
  groupRules,
  kindsFor,
  newRule,
  type RuleJson,
  type RuleKind,
} from "./catalog";
import type { Draft } from "./model";
import { RuleRow } from "./RuleRow";

/** Grouped, friendly form over the draft's rules, plus rounding and "add a rule". */
export function RulesetEditor({
  draft,
  byRule,
  general,
  onChange,
}: {
  draft: Draft;
  /** Problems per rule index (client validation and/or the server's answer). */
  byRule: Map<number, string[]>;
  general: string[];
  onChange: (d: Draft) => void;
}) {
  const roundingId = useId();
  const groups = groupRules(draft.rules);
  const setRule = (index: number, rule: RuleJson) =>
    onChange({ ...draft, rules: draft.rules.map((r, i) => (i === index ? rule : r)) });
  const removeRule = (index: number) =>
    onChange({ ...draft, rules: draft.rules.filter((_, i) => i !== index) });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={roundingId} className="font-medium">
          Rounding
        </label>
        <select
          id={roundingId}
          className={`${inputCls} w-auto`}
          value={String(draft.rounding)}
          onChange={(e) => onChange({ ...draft, rounding: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n} decimal place{n === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        <span className="text-muted">Each player&rsquo;s game total is rounded once.</span>
      </div>

      {general.length > 0 && (
        <ul className="space-y-1" aria-label="Problems with the rules">
          {general.map((g, i) => (
            <li key={i} role="alert" className="text-sm text-error">
              {g}
            </li>
          ))}
        </ul>
      )}

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`grp-${g.id}`} data-testid={`group-${g.id}`}>
          <h4 id={`grp-${g.id}`} className="mb-2 font-medium">
            {g.title}
          </h4>
          <ul className="space-y-3">
            {g.items.map(({ rule, index }) => (
              <RuleRow
                key={index}
                rule={rule}
                index={index}
                errors={byRule.get(index) ?? []}
                onChange={(r) => setRule(index, r)}
                onRemove={() => removeRule(index)}
              />
            ))}
          </ul>
        </section>
      ))}

      <AddRule onAdd={(rule) => onChange({ ...draft, rules: [...draft.rules, rule] })} />
    </div>
  );
}

function AddRule({ onAdd }: { onAdd: (rule: RuleJson) => void }) {
  const statId = useId();
  const kindId = useId();
  const [stat, setStat] = useState<StatKey>("rush_yds");
  const [kind, setKind] = useState<RuleKind>("per_event");
  const kinds = kindsFor(stat);
  const effectiveKind = kinds.includes(kind) ? kind : "per_event";
  return (
    <div className="space-y-2 rounded border border-dashed border-border p-3">
      <p className="text-sm font-medium">Add a rule</p>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div className="min-w-0 flex-1 basis-44">
          <label htmlFor={statId} className="mb-1 block text-xs text-muted">
            Stat
          </label>
          <select
            id={statId}
            className={inputCls}
            value={stat}
            onChange={(e) => setStat(e.target.value as StatKey)}
          >
            {STAT_OPTIONS.map((o) => (
              <option key={o.stat} value={o.stat}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1 basis-44">
          <label htmlFor={kindId} className="mb-1 block text-xs text-muted">
            Type
          </label>
          <select
            id={kindId}
            className={inputCls}
            value={effectiveKind}
            onChange={(e) => setKind(e.target.value as RuleKind)}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => onAdd(newRule(stat, effectiveKind))}
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

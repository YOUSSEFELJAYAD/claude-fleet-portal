'use client';
import React, { useEffect, useState } from 'react';
import { Kicker, Field, Input, Textarea, Select, Btn } from '@/components/ui';
import type {
  LoopContract,
  RiskRule,
  RiskLevel,
  MergePosture,
} from '@/lib/loops';

/** the editable shape this component owns; the parent maps it onto CreateLoopRequest. */
export interface ContractDraft {
  contract: LoopContract;
  mergePosture: MergePosture;
  reviewPolicy: string;
  routableCeiling: RiskLevel;
  riskRubric: RiskRule[];
  escalationThreshold: number;
}

export const DEFAULT_DRAFT: ContractDraft = {
  contract: { job: '', inputs: '', allowed: [], forbidden: [], output: '', evaluation: '' },
  mergePosture: 'human-gate',
  reviewPolicy: 'always',
  routableCeiling: 'low',
  riskRubric: [],
  escalationThreshold: 3,
};

/** newline-or-comma list ⇄ string[] (allowed/forbidden tool patterns). */
const toList = (s: string): string[] =>
  s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const fromList = (xs: string[]): string => xs.join('\n');

export function ContractEditor({
  draft,
  onChange,
  onSave,
  saving,
  saveLabel = 'Save Contract',
}: {
  draft: ContractDraft;
  onChange: (d: ContractDraft) => void;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
}) {
  const c = draft.contract;
  // EVALUATION required — "if you can't grade it, you're not ready to run it autonomously" (spec §3).
  const evalEmpty = !c.evaluation.trim();
  const setContract = (patch: Partial<LoopContract>) =>
    onChange({ ...draft, contract: { ...c, ...patch } });

  // local raw text for the two pattern lists so typing commas/newlines is smooth
  const [allowedRaw, setAllowedRaw] = useState(fromList(c.allowed));
  const [forbiddenRaw, setForbiddenRaw] = useState(fromList(c.forbidden));

  // resync raw text when the parent resets the draft (e.g. after a create, parent sets DEFAULT_DRAFT)
  useEffect(() => { setAllowedRaw(fromList(draft.contract.allowed)); }, [draft.contract.allowed]);
  useEffect(() => { setForbiddenRaw(fromList(draft.contract.forbidden)); }, [draft.contract.forbidden]);

  function addRule() {
    onChange({ ...draft, riskRubric: [...draft.riskRubric, { glob: '', forceRisk: 'high' }] });
  }
  function setRule(i: number, patch: Partial<RiskRule>) {
    onChange({
      ...draft,
      riskRubric: draft.riskRubric.map((r, ix) => (ix === i ? { ...r, ...patch } : r)),
    });
  }
  function removeRule(i: number) {
    onChange({ ...draft, riskRubric: draft.riskRubric.filter((_, ix) => ix !== i) });
  }

  return (
    <div className="grid gap-3.5">
      <Kicker>contract · the six-field pre-flight card</Kicker>

      <Field label="job" hint="the single responsibility">
        <Textarea rows={2} value={c.job} onChange={(e) => setContract({ job: e.target.value })} placeholder="triage the backlog by risk + type" />
      </Field>
      <Field label="inputs" hint="what STATE it inspects">
        <Textarea rows={2} value={c.inputs} onChange={(e) => setContract({ inputs: e.target.value })} placeholder="open Backlog cards + repo context" />
      </Field>

      <Field label="allowed" hint="tool patterns it MAY use · one per line">
        <Textarea
          rows={3}
          value={allowedRaw}
          onChange={(e) => { setAllowedRaw(e.target.value); setContract({ allowed: toList(e.target.value) }); }}
          placeholder={'Read\nGrep\nBash(git diff *)'}
        />
      </Field>
      <Field label="forbidden" hint="patterns it must NEVER use · merged on top of the project deny-list">
        <Textarea
          rows={3}
          value={forbiddenRaw}
          onChange={(e) => { setForbiddenRaw(e.target.value); setContract({ forbidden: toList(e.target.value) }); }}
          placeholder={'Edit\nWrite\nBash(git push *)'}
        />
      </Field>

      <Field label="output" hint="the concrete artifact after a good run">
        <Textarea rows={2} value={c.output} onChange={(e) => setContract({ output: e.target.value })} placeholder="every item labeled + an Agent Assessment comment" />
      </Field>
      <Field label="evaluation" hint="REQUIRED — how we grade success">
        <Textarea
          rows={2}
          value={c.evaluation}
          onChange={(e) => setContract({ evaluation: e.target.value })}
          placeholder="no risk:high marked agent:ready; every verdict reason is evidence-backed"
          className={evalEmpty ? 'border-sig-failed/50' : ''}
        />
        {evalEmpty && (
          <div className="text-sig-failed font-mono text-[10px] mt-1">
            evaluation is required — a loop you can&rsquo;t grade can&rsquo;t run autonomously
          </div>
        )}
      </Field>

      <div className="border-t hairline pt-3 grid grid-cols-2 gap-3">
        <Field label="merge posture" hint="human-gate never merges">
          <Select value={draft.mergePosture} onChange={(e) => onChange({ ...draft, mergePosture: e.target.value as MergePosture })}>
            <option value="human-gate">human-gate</option>
            <option value="auto-low-risk">auto-low-risk</option>
          </Select>
        </Field>
        <Field label="routable ceiling" hint="max risk markable agent:ready">
          <Select value={draft.routableCeiling} onChange={(e) => onChange({ ...draft, routableCeiling: e.target.value as RiskLevel })}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </Select>
        </Field>
        <Field label="review policy" hint="always | off | threshold:N">
          <Input value={draft.reviewPolicy} onChange={(e) => onChange({ ...draft, reviewPolicy: e.target.value })} placeholder="always" />
        </Field>
        <Field label="escalation threshold" hint="clean dry-runs → auto-apply">
          <Input
            type="number"
            min={1}
            value={String(draft.escalationThreshold)}
            onChange={(e) => onChange({ ...draft, escalationThreshold: Number(e.target.value) || 1 })}
          />
        </Field>
      </div>

      <Field label="risk rubric" hint="path globs forced to a risk floor (overrides the agent)">
        <div className="grid gap-2">
          {draft.riskRubric.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              {/* min-w-0 lets the glob input actually shrink/grow in the flex row; the Select needs
                  !w-28 + shrink-0 to beat inputCls's baked-in `w-full` (otherwise it stretches full
                  width and collapses the glob field to ~0). */}
              <Input value={r.glob} onChange={(e) => setRule(i, { glob: e.target.value })} placeholder="**/auth/**" className="flex-1 min-w-0" />
              <Select value={r.forceRisk} onChange={(e) => setRule(i, { forceRisk: e.target.value as RiskLevel })} className="!w-28 shrink-0">
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </Select>
              <Btn variant="danger" onClick={() => removeRule(i)} className="!px-2 !py-1 shrink-0">✕</Btn>
            </div>
          ))}
          <Btn variant="ghost" onClick={addRule} className="justify-center">＋ add rule</Btn>
        </div>
      </Field>

      <Btn type="button" variant="solid" onClick={onSave} disabled={saving || evalEmpty} className="w-full justify-center" title={evalEmpty ? 'evaluation is required' : undefined}>
        {saving ? 'saving…' : saveLabel}
      </Btn>
    </div>
  );
}

'use client';

import type { ModelInfo, RunEngine } from '@fleet/shared';
import { Input, Select } from './ui';

export const CUSTOM_MODEL_PREFIX = '__custom:';

export function customModelValue(engine: Exclude<RunEngine, 'claude'>) {
  return `${CUSTOM_MODEL_PREFIX}${engine}`;
}

export function customModelEngine(value: string): Exclude<RunEngine, 'claude'> | null {
  if (value === customModelValue('codex')) return 'codex';
  if (value === customModelValue('opencode')) return 'opencode';
  return null;
}

export function modelEngine(models: ModelInfo[], value: string): RunEngine {
  const custom = customModelEngine(value);
  if (custom) return custom;
  return models.find((m) => m.id === value)?.engine ?? 'claude';
}

const ENGINE_LABELS: Record<RunEngine, string> = {
  claude: 'Claude',
  codex: 'Codex (ChatGPT)',
  opencode: 'OpenCode',
};

function price(m: ModelInfo) {
  return m.inputPerM || m.outputPerM ? ` · $${m.inputPerM}/${m.outputPerM}` : '';
}

export function ModelSelect({
  models,
  value,
  onChange,
  enabledEngines = ['claude'],
  allowCustom = true,
  customValue = '',
  onCustomValueChange,
  defaultOption,
  disabled = false,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (value: string) => void;
  enabledEngines?: RunEngine[];
  allowCustom?: boolean;
  customValue?: string;
  onCustomValueChange?: (value: string) => void;
  defaultOption?: { value: string; label: string };
  disabled?: boolean;
}) {
  const enabled = new Set<RunEngine>(['claude', ...enabledEngines]);
  const selectedCustom = customModelEngine(value);
  const byEngine = (engine: RunEngine) => models.filter((m) => (m.engine ?? 'claude') === engine);

  // A controlled <select> whose value matches no rendered <option> silently shows the first
  // option while state keeps the real value — desyncing the dropdown from what gets saved/sent.
  // This happens when `value` is an engine model (e.g. a saved template's gpt-5-codex) but that
  // engine's add-on is disabled, so its optgroup is not rendered. Keep the value selectable.
  const selectedHidden = models.find(
    (m) => m.id === value && (m.engine ?? 'claude') !== 'claude' && !enabled.has(m.engine ?? 'claude'),
  );

  return (
    <>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {defaultOption && <option value={defaultOption.value}>{defaultOption.label}</option>}
        {selectedHidden && (
          <option value={selectedHidden.id}>
            {selectedHidden.label} ({ENGINE_LABELS[selectedHidden.engine ?? 'claude']} add-on disabled)
          </option>
        )}
        <optgroup label={ENGINE_LABELS.claude}>
          {byEngine('claude').map((m) => (
            <option key={m.id} value={m.id}>{m.label}{price(m)}</option>
          ))}
        </optgroup>
        {(['codex', 'opencode'] as const).map((engine) => (
          enabled.has(engine) ? (
            <optgroup key={engine} label={ENGINE_LABELS[engine]}>
              {byEngine(engine).map((m) => (
                <option key={m.id} value={m.id}>{m.label}{price(m)}</option>
              ))}
              {allowCustom && <option value={customModelValue(engine)}>Custom {ENGINE_LABELS[engine]} model...</option>}
            </optgroup>
          ) : null
        ))}
      </Select>
      {selectedCustom && onCustomValueChange && (
        <Input
          value={customValue}
          onChange={(e) => onCustomValueChange(e.target.value)}
          placeholder={selectedCustom === 'codex' ? 'gpt-5-codex' : 'anthropic/claude-sonnet-4-5'}
          className="mt-2"
          disabled={disabled}
        />
      )}
    </>
  );
}

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

  return (
    <>
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {defaultOption && <option value={defaultOption.value}>{defaultOption.label}</option>}
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

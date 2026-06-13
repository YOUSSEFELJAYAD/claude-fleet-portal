/**
 * §29 — slash-command control-plane for the chat dashboard. Each command dispatches to an
 * existing registry/module call; results render as command-result messages. Commands inherit the
 * permission posture of the calls they make (DC §D-031).
 */
import { registry } from './registry.js';
import { listAddonInfos, setAddonEnabledById } from './addons.js';
import { campaigns } from './campaigns.js';
import type { ChatCommandResult } from '@fleet/shared';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
const ok = (text: string, extra: Partial<ChatCommandResult> = {}): ChatCommandResult => ({ ok: true, kind: 'text', text, ...extra });
const err = (text: string): ChatCommandResult => ({ ok: false, kind: 'error', text });

const HELP = [
  '/agents — list running agents',
  '/kill <id> — stop a run',
  '/launch <prompt> — start an agent in the chat cwd',
  '/campaign <objective> — start a campaign',
  '/addons — list add-ons',
  '/addon enable|disable <id> — toggle an add-on',
  '/schedule — open the Schedules page',
  '/help — this list',
].join('\n');

/** Parse and run one slash-command line. `cwd` is the chat session's working dir. */
export async function dispatchCommand(line: string, cwd: string): Promise<ChatCommandResult> {
  const trimmed = line.trim().replace(/^\//, '');
  const [name, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ');
  switch (name) {
    case 'help': return ok(HELP);
    case 'agents': {
      const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
      return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
        rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
    }
    case 'kill': {
      if (!arg) return err('usage: /kill <run-id>');
      try { registry.stop(arg); return ok(`stopped ${arg}`); }
      catch (e: any) { return err(e?.message ?? 'kill failed'); }
    }
    case 'launch': {
      if (!arg) return err('usage: /launch <prompt>');
      try {
        const run = await registry.launch({ prompt: arg, cwd, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default' });
        return ok(`launched run ${run.id}`, { runId: run.id });
      } catch (e: any) { return err(e?.message ?? 'launch failed'); }
    }
    case 'campaign': {
      if (!arg) return err('usage: /campaign <objective>');
      try { const c = await campaigns.create({ objective: arg, cwd }); return ok(`started campaign ${c.id}`); }
      catch (e: any) { return err(e?.message ?? 'campaign failed'); }
    }
    case 'addons': {
      const infos = await listAddonInfos();
      return { ok: true, kind: 'table', columns: ['id', 'enabled', 'status'],
        rows: infos.map((a) => [a.id, String(a.enabled), a.status]) };
    }
    case 'addon': {
      const [action, id] = rest;
      if ((action !== 'enable' && action !== 'disable') || !id) return err('usage: /addon enable|disable <id>');
      try { const info = await setAddonEnabledById(id, action === 'enable'); return ok(`${id} → ${info.status}`); }
      catch (e: any) { return err(e?.message ?? 'addon toggle failed'); }
    }
    case 'schedule': return ok('Open the Schedules page to create or manage schedules: /schedules');
    default: return err(`unknown command: /${name} — try /help`);
  }
}

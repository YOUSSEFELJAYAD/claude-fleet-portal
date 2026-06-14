/**
 * §30/§5 — declarative slash-command control-plane. ONE registry feeds both dispatchCommand
 * AND the GET /api/commands wire (Task 3). Each entry carries a server-only run(ctx); the wire
 * shape (CommandDef) omits it. Commands inherit the permission posture of the calls they make
 * (DC §D-031); destructive verbs are flagged danger:true and route through the Inbox queue.
 */
import { registry } from './registry.js';
import { listAddonInfos, setAddonEnabledById } from './addons.js';
import { campaigns } from './campaigns.js';
import { enqueueApproval } from './inbox.js';
import type { ChatCommandResult, CommandDef } from '@fleet/shared';

const TERMINAL = new Set(['completed', 'failed', 'killed']);
const ok = (text: string, extra: Partial<ChatCommandResult> = {}): ChatCommandResult => ({ ok: true, kind: 'text', text, ...extra });
const err = (text: string): ChatCommandResult => ({ ok: false, kind: 'error', text });

/** Context handed to every command's run(). `args` is the raw arg tokens; `arg` is them joined. */
export interface CommandContext { args: string[]; arg: string; cwd: string; }

/** In-memory registry entry: a wire CommandDef plus the server-only executor. */
export type CommandEntry = CommandDef & { run(ctx: CommandContext): Promise<ChatCommandResult> };

const COMMANDS: CommandEntry[] = [
  {
    name: 'help', group: 'meta', description: 'List available slash commands',
    usage: '/help', args: [], resultKind: 'text',
    run: async () => ok(COMMANDS.map((c) => `${c.usage} — ${c.description}`).join('\n')),
  },
  {
    name: 'agents', group: 'control', description: 'List running agents',
    usage: '/agents', args: [], resultKind: 'table',
    run: async () => {
      const runs = (registry.listRuns() as any[]).filter((r) => !TERMINAL.has(r.status));
      return { ok: true, kind: 'table', columns: ['id', 'status', 'model', 'task'],
        rows: runs.map((r) => [r.id, r.status, r.model, String(r.task ?? '').slice(0, 60)]) };
    },
  },
  {
    name: 'kill', group: 'control', description: 'Stop a run', usage: '/kill <run-id>',
    args: [{ name: 'run-id', required: true, type: 'run-id', source: 'running-runs', hint: 'a running run id' }],
    resultKind: 'ack', danger: true,
    run: async ({ arg }) => {
      if (!arg) return err('usage: /kill <run-id>');
      try { registry.stop(arg); return ok(`stopped ${arg}`); }
      catch (e: any) { return err(e?.message ?? 'kill failed'); }
    },
  },
  {
    name: 'launch', group: 'control', description: 'Start an agent in the chat cwd',
    usage: '/launch <prompt>',
    args: [{ name: 'prompt', required: true, type: 'prompt', hint: 'what the agent should do' }],
    resultKind: 'ack',
    run: async ({ arg, cwd }) => {
      if (!arg) return err('usage: /launch <prompt>');
      try {
        const run = await registry.launch({ prompt: arg, cwd, model: 'claude-opus-4-8', effort: 'high', permissionMode: 'default' });
        return ok(`launched run ${run.id}`, { runId: run.id });
      } catch (e: any) { return err(e?.message ?? 'launch failed'); }
    },
  },
  {
    name: 'campaign', group: 'control', description: 'Start a campaign', usage: '/campaign <objective>',
    args: [{ name: 'objective', required: true, type: 'string', hint: 'campaign objective' }],
    resultKind: 'ack', danger: true,
    run: async ({ arg, cwd }) => {
      if (!arg) return err('usage: /campaign <objective>');
      try { const c = await campaigns.create({ objective: arg, cwd }); return ok(`started campaign ${c.id}`); }
      catch (e: any) { return err(e?.message ?? 'campaign failed'); }
    },
  },
  {
    name: 'addons', group: 'config', description: 'List add-ons', usage: '/addons',
    args: [], resultKind: 'table',
    run: async () => {
      const infos = await listAddonInfos();
      return { ok: true, kind: 'table', columns: ['id', 'enabled', 'status'],
        rows: infos.map((a) => [a.id, String(a.enabled), a.status]) };
    },
  },
  {
    name: 'addon', group: 'config', description: 'Enable or disable an add-on',
    usage: '/addon enable|disable <id>',
    args: [
      { name: 'action', required: true, type: 'enum', enum: ['enable', 'disable'] },
      { name: 'id', required: true, type: 'string', source: 'addons', hint: 'add-on id' },
    ],
    resultKind: 'ack',
    run: async ({ args }) => {
      const [action, id] = args;
      if ((action !== 'enable' && action !== 'disable') || !id) return err('usage: /addon enable|disable <id>');
      try { const info = await setAddonEnabledById(id, action === 'enable'); return ok(`${id} → ${info.status}`); }
      catch (e: any) { return err(e?.message ?? 'addon toggle failed'); }
    },
  },
  {
    name: 'schedule', group: 'project', description: 'Open the Schedules page', usage: '/schedule',
    args: [], resultKind: 'text',
    run: async () => ok('Open the Schedules page to create or manage schedules: /schedules'),
  },
  {
    name: 'stop-all',
    group: 'control',
    description: 'Stop every running agent in the fleet',
    usage: '/stop-all',
    args: [],
    resultKind: 'ack',
    danger: true,
    async run() {
      // never reached while danger:true (dispatchCommand parks it); kept for when an
      // approved action replays the command. Returns a text ack of the count stopped.
      const n = registry.stopAll();
      return { ok: true, kind: 'text', text: `stopped ${n} run(s)` };
    },
  },
];

/** Wire view: the CommandDefs the GET /api/commands route serializes (run() stripped). */
export function listCommands(): CommandDef[] {
  return COMMANDS.map(({ run, ...wire }) => wire);
}

/** Parse and run one slash-command line. `cwd` is the chat session's working dir. */
export async function dispatchCommand(line: string, cwd: string): Promise<ChatCommandResult> {
  const trimmed = line.trim().replace(/^\//, '');
  const [name, ...rest] = trimmed.split(/\s+/);
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return err(`unknown command: /${name} — try /help`);
  if (cmd.danger) {
    const id = enqueueApproval({ command: cmd.name, summary: cmd.description, cwd });
    return { ok: true, kind: 'text', text: `Queued "/${cmd.name}" for approval (Inbox · ${id}). It will run once approved.` };
  }
  return cmd.run({ args: rest, arg: rest.join(' '), cwd });
}

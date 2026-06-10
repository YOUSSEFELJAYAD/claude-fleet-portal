#!/usr/bin/env node
/**
 * mock-claude — a drop-in stand-in for `claude -p --output-format stream-json`.
 *
 * Replays a captured/synthesized stream-json fixture line-by-line with a small
 * delay, rewriting `session_id` to the `--session-id` the portal passed in. Lets
 * the entire control-plane pipeline (process manager → parser → tree builder →
 * SSE) be exercised for free and deterministically (real Opus 4.8 calls cost
 * ~$0.18–0.32 each — DC.md F-5/D-009).
 *
 * Honors:
 *   --session-id <uuid>     stamped into every emitted event
 *   --input-format stream-json  → after replay, stay alive and answer stdin
 *   env MOCK_FIXTURE        fixture path or bare name (default: workflow-fanout)
 *   env MOCK_DELAY_MS       inter-event delay in ms (default: 120; tests use 0)
 *   env MOCK_EXIT_CODE      process exit code after replay (default: 0)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const sessionId = flag('--session-id') || '00000000-0000-0000-0000-000000000000';
const streamInput = flag('--input-format') === 'stream-json';
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 120);
const exitCode = Number(process.env.MOCK_EXIT_CODE ?? 0);

// Campaign-aware fixture selection: an orchestrator run carries --json-schema (it must
// return a plan) → replay the plan fixture; campaign workers (CLAUDE_BIN set + no schema)
// → replay a quick worker fixture. Plain runs → MOCK_FIXTURE (default workflow-fanout).
const hasSchema = argv.includes('--json-schema');
let fixtureArg = hasSchema
  ? process.env.MOCK_PLAN_FIXTURE || 'orchestrator-plan'
  : process.env.MOCK_FIXTURE || 'workflow-fanout';
if (!fixtureArg.endsWith('.jsonl')) fixtureArg = `${fixtureArg}.jsonl`;
const fixturePath = isAbsolute(fixtureArg)
  ? fixtureArg
  : join(__dirname, '..', 'fixtures', fixtureArg);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

let alive = true;
const die = (code = 143) => {
  alive = false;
  process.exit(code);
};
process.on('SIGTERM', () => die(143));
process.on('SIGINT', () => die(130));

async function main() {
  let raw;
  try {
    raw = readFileSync(fixturePath, 'utf8');
  } catch (e) {
    process.stderr.write(`mock-claude: cannot read fixture ${fixturePath}: ${e.message}\n`);
    process.exit(2);
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));

  for (const line of lines) {
    if (!alive) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.session_id) obj.session_id = sessionId;
    write(obj);
    if (delayMs > 0) await sleep(delayMs);
  }

  if (streamInput) {
    // Stay alive and respond to follow-up user messages from stdin (PRD §7.6 send-input).
    // The first stdin message is the run's initial prompt (registry writes it at spawn);
    // the fixture replay is already its answer, so swallow it.
    let initialPromptSeen = false;
    const rl = createInterface({ input: process.stdin });
    rl.on('line', async (l) => {
      l = l.trim();
      if (!l.startsWith('{')) return;
      let msg;
      try {
        msg = JSON.parse(l);
      } catch {
        return;
      }
      if (!initialPromptSeen) {
        initialPromptSeen = true;
        return;
      }
      const text =
        msg?.message?.content?.[0]?.text ??
        (typeof msg?.message?.content === 'string' ? msg.message.content : '(follow-up)');
      await sleep(delayMs);
      write({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          role: 'assistant',
          content: [{ type: 'text', text: `Acknowledged follow-up: "${text}". Continuing.` }],
          usage: { input_tokens: 500, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: 'followup_' + Date.now(),
      });
    });
    rl.on('close', () => die(exitCode));
  } else {
    process.exit(exitCode);
  }
}

main();

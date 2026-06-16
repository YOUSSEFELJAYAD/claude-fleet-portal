import type { FastifyInstance } from 'fastify';
import { enqueueGate } from './gate.js';

export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }

const ASK_HUMAN_TOOL = {
  name: 'ask_human',
  description: 'Ask the human operator a question and BLOCK until they answer in the portal Inbox. Use this for any decision you need from a human — AskUserQuestion will not reach them in this environment.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      multiSelect: { type: 'boolean' },
      allowFreeText: { type: 'boolean' },
    },
    required: ['question', 'options'],
  },
};

export async function handleAskHuman(
  sessionId: string,
  args: { question?: string; options?: string[]; multiSelect?: boolean; allowFreeText?: boolean },
): Promise<ToolResult> {
  if (!args || typeof args.question !== 'string' || !Array.isArray(args.options) || args.options.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'ask_human requires { question: string, options: string[] }' }] };
  }
  const gate = enqueueGate({
    sessionId,
    question: args.question,
    options: args.options.map(String),
    multiSelect: !!args.multiSelect,
    allowFreeText: !!args.allowFreeText,
  });
  try {
    const a = await gate.answer;
    let text = a.selection.join(', ');
    if (a.text && a.text.trim()) text += `\n\nNote: ${a.text.trim()}`;
    return { content: [{ type: 'text', text: text || '(no selection)' }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: `ask_human cancelled: ${e?.message ?? 'run ended'}` }] };
  }
}

// Minimal JSON-RPC 2.0 over HTTP (application/json; NO SSE) — exactly what the spike proved claude 2.1.178 needs.
export function registerGateRoutes(app: FastifyInstance) {
  // claude opens an SSE GET and a teardown DELETE; neither is needed for request/response tools.
  app.get('/mcp/:sessionId', async (_req, reply) => reply.code(405).send());
  app.delete('/mcp/:sessionId', async (_req, reply) => reply.code(200).send());

  app.post('/mcp/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const msg = (req.body ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: any };

    // JSON-RPC notifications (no id), e.g. notifications/initialized → 202, empty body.
    if (msg.id == null) return reply.code(202).send();

    if (msg.method === 'initialize') {
      reply.header('Mcp-Session-Id', sessionId);
      return reply.send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fleet-gate', version: '1.0.0' },
        },
      });
    }
    if (msg.method === 'tools/list') {
      return reply.send({ jsonrpc: '2.0', id: msg.id, result: { tools: [ASK_HUMAN_TOOL] } });
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'ask_human') {
      const result = await handleAskHuman(sessionId, msg.params?.arguments ?? {});
      return reply.send({ jsonrpc: '2.0', id: msg.id, result });
    }
    return reply.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  });
}

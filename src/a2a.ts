// a2a.ts — the A2A calls an agent card invites, answered on the MCP endpoint.
//
// Every card here names the MCP endpoint as its `url` with `preferredTransport:
// JSONRPC`, which to an A2A client means "send `message/send` here". The
// endpoint answered -32601, so the card promised an interface the server then
// refused: A2A clients and the registries that probe for them sent about 140
// such calls per origin in a fortnight (October 2026) and got nothing back.
// Now a message is answered with the site's own search, and the task methods
// say plainly that no task exists, since every answer is a direct message.
//
// Both revisions in the field are spoken: v0.3 (`message/send`, a Message with
// `kind`) and v1.0 (`SendMessage`, a `{ message }` with proto-JSON enums).

import { McpToolError, type McpServerConfig, type RpcRequest } from './mcp.js';

type Revision = '0.3' | '1.0';

const SEND: Record<string, Revision> = { 'message/send': '0.3', SendMessage: '1.0' };

/** Task methods: none can succeed, because no task is ever created. */
const TASK = new Set(['tasks/get', 'tasks/cancel', 'tasks/resubscribe', 'GetTask', 'CancelTask', 'SubscribeToTask']);

/** Everything else either revision defines, which this server declines. */
const UNSUPPORTED = new Set([
  'message/stream',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
  'agent/getAuthenticatedExtendedCard',
  'SendStreamingMessage',
  'ListTasks',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
]);

/** @internal */
export const isA2aMethod = (method: string) => Object.hasOwn(SEND, method) || TASK.has(method) || UNSUPPORTED.has(method);

const error = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

/** The text of a message's text parts, whichever revision shaped them. */
function textOf(message: unknown): string {
  const parts = (message as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(p => (p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join(' ')
    .trim();
}

/** What a message gets when there is no search to run: what this server is and how to use it. */
const orientation = (config: McpServerConfig) =>
  `${config.instructions}\n\nThis endpoint also speaks MCP (JSON-RPC over POST): send "initialize", then "tools/list". Tools: ${config.tools.map(t => t.name).join(', ')}.`;

async function reply(text: string, config: McpServerConfig): Promise<{ text: string; data?: object }> {
  const tool = config.answer && config.tools.find(t => t.name === config.answer!.tool);
  if (!text || !tool) return { text: orientation(config) };
  try {
    const out = await tool.handler({ [config.answer!.argument]: text }, {
      meta: {},
      setMeta: () => {},
      protocolVersion: '2025-11-25',
    });
    const lead = `${config.serverInfo.name} ${tool.name} for ${JSON.stringify(text)}. For more, call this endpoint over MCP: "initialize", then "tools/list".`;
    if (typeof out === 'string') return { text: `${lead}\n\n${out}` };
    // The text twin stays beside the data, as it does on an MCP tool result:
    // a client that reads only text parts still has to be able to read the answer.
    return { text: `${lead}\n\n${JSON.stringify(out ?? null, null, 2)}`, ...(out && typeof out === 'object' && !Array.isArray(out) ? { data: out } : {}) };
  } catch (err) {
    if (err instanceof McpToolError) return { text: `${err.message}\n\n${orientation(config)}` };
    throw err;
  }
}

/** Answer one A2A call. Only reached for a method `isA2aMethod` accepts. @internal */
export async function handleA2a(req: RpcRequest, config: McpServerConfig): Promise<object> {
  const { id, method } = req;
  if (TASK.has(method)) {
    return error(id, -32001, 'Task not found: this agent keeps no tasks. Every message it is sent is answered directly with a message.');
  }
  const revision = SEND[method];
  if (!revision) {
    const send = method.includes('/') ? 'message/send' : 'SendMessage';
    return error(id, -32004, `Unsupported operation: "${method}". This agent answers ${send} only, without streaming or push notifications.`);
  }
  const message = (req.params as { message?: { contextId?: unknown } } | undefined)?.message;
  if (!message || typeof message !== 'object') {
    return error(id, -32602, 'Missing params.message: send a message with at least one text part.');
  }
  const { text, data } = await reply(textOf(message), config);
  const contextId = typeof message.contextId === 'string' ? message.contextId : crypto.randomUUID();
  const messageId = crypto.randomUUID();
  if (revision === '1.0') {
    const parts = [{ text }, ...(data ? [{ data }] : [])];
    return { jsonrpc: '2.0', id, result: { message: { messageId, contextId, role: 'ROLE_AGENT', parts } } };
  }
  const parts = [{ kind: 'text', text }, ...(data ? [{ kind: 'data', data }] : [])];
  return { jsonrpc: '2.0', id, result: { kind: 'message', messageId, contextId, role: 'agent', parts } };
}

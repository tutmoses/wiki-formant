// x402.ts — per-call payment gating for an MCP envelope.
//
// THE LEAK THIS CLOSES. Paywalling a bulk HTTP export while the MCP tool that
// returns the same bytes stays free reroutes a scraper one endpoint over. A
// price one surface honours and its twin does not is not a price.
//
// WHY NOT AN HTTP 402 ON THE MCP ROUTE. One status covers one POST, and an MCP
// server accepts batches — a batch of [search, get_catalogue, create_checkout]
// would have to 402 all three or bill none. A blanket 402 would also block the
// free tools that share the URL. And no MCP client would understand it: a
// non-2xx from the transport reads as "server error", which is why the x402
// Foundation's own MCP integration does not use HTTP 402 either.
//
// SO PAYMENT TRAVELS IN-BAND, in the JSON-RPC envelope, in the places @x402/mcp
// puts it:
//
//   client -> server            params._meta["x402/payment"]        PaymentPayload
//   unpaid tool   -> client     tool result, isError + structuredContent
//   unpaid resource -> client   JSON-RPC error -32042, data: PaymentRequired
//   paid -> client              result._meta["x402/payment-response"]  SettleResponse
//
// (resources/read has no isError result shape, hence the two forms.)
//
// WHY THIS IS ITS OWN SUBPATH, AND WHY IT IMPORTS NOTHING.
// `wiki-formant` has no runtime dependencies and no framework peer, and x402 is
// a stack of them — @x402/core, @x402/evm, @x402/extensions and viem behind
// those. They are declared here as OPTIONAL peers, because a caller genuinely
// cannot build an `x402ResourceServer` without them, and a wiki that never
// imports `wiki-formant/x402` never resolves, installs or loads any of it.
//
// But this file imports none of them either. The resource server arrives as a
// PORT, for the same reason the Prisma delegates in `rola.ts` do: the caller
// already holds a configured one, its construction is deployment policy (which
// chain, which facilitator, whose gas key, whose money), and typing it
// structurally is what keeps a viem-sized dependency tree out of a package
// three other wikis install. `declareDiscoveryExtension` arrives the same way,
// so the lazy `import()` that keeps it off the free path stays lazy and stays
// the caller's.
//
// WHAT STAYS WITH THE CALLER, deliberately: which surfaces cost what, the
// prices, the terms text, the service name and the sentence that tells an agent
// how to pay. Those are policy. What is here is the envelope surgery —
// verify before dispatch, settle only after a non-error answer, splice the
// challenges back into the caller's original order — which is the part that is
// the same wherever it is written and the part that is easy to get subtly
// wrong.

import type { RpcRequest } from './mcp.js';

/**
 * The slice of `@x402/core`'s `x402ResourceServer` this module calls.
 *
 * Method syntax, not properties: the real methods carry the library's own
 * `PaymentPayload` / `PaymentRequirements` types, and bivariant method
 * parameters are what lets a real server satisfy a port written in `unknown`.
 */
export interface X402ServerPort {
  buildPaymentRequirements(spec: {
    scheme: 'exact';
    network: string;
    payTo: string;
    price: string;
    maxTimeoutSeconds: number;
  }): Promise<unknown>;
  createPaymentRequiredResponse(
    accepts: unknown,
    resource: {
      url: string;
      description: string;
      mimeType: string;
      serviceName: string;
      tags: string[];
    },
    error: string,
    extensions: unknown,
    context: unknown,
    payload?: unknown,
  ): Promise<unknown>;
  findMatchingRequirements(accepts: unknown, payload: unknown): unknown;
  verifyPayment(
    payload: unknown,
    requirements: unknown,
    extensions: unknown,
    context: unknown,
  ): Promise<{ isValid: boolean; invalidReason?: string }>;
  settlePayment(
    payload: unknown,
    requirements: unknown,
    extensions: unknown,
    context: unknown,
  ): Promise<{ success?: boolean }>;
}

/** One priced surface, as the caller describes it. All of this is policy. */
export interface PaidSurface {
  /**
   * Which envelope slot the challenge can travel in. A tool result carries
   * `structuredContent`; a `resources/read` has no such shape and takes a
   * JSON-RPC error instead.
   */
  kind: 'tool' | 'resource';
  /** Canonical URL of the thing being sold, for the 402 body and the catalogue. */
  resource: string;
  price: string;
  mimeType: string;
  description: string;
  /** The sentence an unpaid caller reads. Say what else is free. */
  unpaidMessage: string;
  /**
   * Bazaar's MCP discovery shape, so an agent that would pay can find this in
   * the catalogue instead of finding it by being refused. The shape is defined
   * for tools, not resources — a `resources/read` has no tool name or input
   * schema to catalogue — so leave it undefined there rather than describing it
   * as something it is not. Declared through `GateOptions.declareDiscovery`,
   * and only for an entry that has actually been asked for.
   */
  discovery?: Record<string, unknown>;
  /** Passed through to the facilitator as call context, verbatim. */
  context: unknown;
}

export interface GateOptions {
  /**
   * Built lazily, and allowed to throw. An unreachable facilitator throws out
   * of `initialize()` rather than returning anything, and the gate turns that
   * into a withheld paid entry instead of a 500 that would take the free tools
   * in the same batch down with it.
   */
  server: () => Promise<X402ServerPort>;
  /** Which paid surface, if any, an envelope entry addresses. */
  resolve: (entry: RpcRequest) => PaidSurface | null;
  network: string;
  payTo: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  tags: string[];
  /** Must match the cap `handleMcp` will apply. See the passthrough below. */
  maxBatch: number;
  /** False when this deployment charges for nothing. Everything passes through. */
  enabled?: boolean;
  /**
   * `@x402/extensions/bazaar`'s `declareDiscoveryExtension`, reached however
   * the caller reaches it — this package does not import @x402 and will not
   * start. Keep it a lazy `import()` on that side: it is only ever called for a
   * surface somebody has actually requested, so the free path never loads it.
   */
  declareDiscovery?: (discovery: Record<string, unknown>) => Promise<unknown>;
}

export interface Gate {
  /** What `handleMcp` should dispatch — blocked entries removed. */
  body: RpcRequest | RpcRequest[];
  /** True when nothing survived: answer 202 rather than handing over an empty batch. */
  empty: boolean;
  /** Splice the challenges back in and attach settlement receipts. */
  finish: (dispatched: object | object[] | null) => Promise<object | object[] | null>;
}

/** Structural check only — `verifyPayment` does the real one, as @x402/mcp does. */
function metaPayment(req: RpcRequest): unknown | null {
  const meta = ((req.params ?? {}) as { _meta?: Record<string, unknown> })._meta;
  const payment = meta?.['x402/payment'];
  return payment && typeof payment === 'object' && 'x402Version' in payment && 'payload' in payment
    ? payment
    : null;
}

const passthrough = (body: unknown): Gate => ({
  body: body as RpcRequest | RpcRequest[],
  empty: false,
  finish: async r => r,
});

/**
 * Verify payment for every paid entry, withhold the unpaid ones, and return a
 * `finish` that reassembles the response.
 *
 * The ordering mirrors `withX402`: verify BEFORE dispatch, settle only AFTER
 * the handler produced something that is not an error. A tool that raises
 * cancels rather than settles — the caller pays for an answer, not an attempt.
 */
export async function gatePaidCalls(raw: unknown, options: GateOptions): Promise<Gate> {
  const { resolve, network, payTo, maxTimeoutSeconds, serviceName, tags, maxBatch } = options;
  if (options.enabled === false) return passthrough(raw);

  const isBatch = Array.isArray(raw);
  const entries = (isBatch ? raw : [raw]) as RpcRequest[];

  // Malformed or oversized bodies go straight through: handleMcp owns those
  // errors and says them better. The batch cap especially — it is enforced
  // downstream, after this function would have removed entries, so a 500-entry
  // batch must not be allowed to shrink past it here.
  if (!entries.length || entries.length > maxBatch) return passthrough(raw);
  if (entries.some(e => !e || typeof e !== 'object')) return passthrough(raw);

  const targets = entries
    .map((entry, index) => ({ entry, index, spec: resolve(entry) }))
    .filter((t): t is { entry: RpcRequest; index: number; spec: PaidSurface } => t.spec !== null);

  // The overwhelmingly common case: nothing paid in this envelope, so the
  // facilitator is never contacted and the free surface pays no latency for
  // the existence of the paid one.
  if (!targets.length) return passthrough(raw);

  const blocked = new Map<number, object>();
  const settlers = new Map<number, Settler>();

  /** A withheld entry, in whichever form this method can carry. */
  const refuse = (entry: RpcRequest, kind: 'tool' | 'resource', message: string, data?: unknown) =>
    kind === 'tool'
      ? {
          jsonrpc: '2.0' as const,
          id: entry.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data ?? { error: message }) }],
            ...(data ? { structuredContent: data } : {}),
            isError: true,
          },
        }
      : { jsonrpc: '2.0' as const, id: entry.id, error: { code: -32042, message, data } };

  // An unreachable facilitator THROWS out of initialize() rather than returning
  // anything. Uncaught here it would 500 the entire POST — taking down the free
  // tools in the same batch, which is precisely the blast radius this per-entry
  // design exists to avoid. Withhold only the paid entries and let everything
  // else through.
  let server: X402ServerPort;
  try {
    server = await options.server();
  } catch {
    for (const { entry, index, spec } of targets) {
      blocked.set(
        index,
        refuse(entry, spec.kind, 'Payment verification is temporarily unavailable. Retry shortly.'),
      );
    }
    return finishWith(entries, isBatch, blocked, new Map());
  }

  for (const { entry, index, spec } of targets) {
    const accepts = await server.buildPaymentRequirements({
      scheme: 'exact',
      network,
      payTo,
      price: spec.price,
      maxTimeoutSeconds,
    });

    // The full PaymentRequired object, in whichever envelope slot this method
    // has: a tool result can carry structuredContent, resources/read cannot.
    const extensions = spec.discovery && options.declareDiscovery
      ? await options.declareDiscovery(spec.discovery)
      : undefined;

    const challenge = async (error: string, payload?: unknown) =>
      refuse(entry, spec.kind, error, await server.createPaymentRequiredResponse(
        accepts,
        {
          url: spec.resource,
          description: spec.description,
          mimeType: spec.mimeType,
          serviceName,
          tags,
        },
        error,
        extensions,
        spec.context,
        payload,
      ));

    const payload = metaPayment(entry);
    if (!payload) {
      blocked.set(index, await challenge(spec.unpaidMessage));
      continue;
    }

    const requirements = server.findMatchingRequirements(accepts, payload);
    if (!requirements) {
      blocked.set(index, await challenge('No matching payment requirements found.', payload));
      continue;
    }

    const verify = await server.verifyPayment(payload, requirements, extensions, spec.context);
    if (!verify.isValid) {
      blocked.set(index, await challenge(verify.invalidReason || 'Payment verification failed.', payload));
      continue;
    }

    settlers.set(index, () => server.settlePayment(payload, requirements, extensions, spec.context));
  }

  return finishWith(entries, isBatch, blocked, settlers);
}

type Settler = () => Promise<{ success?: boolean }>;

/**
 * Assemble the Gate: what to dispatch, and how to put the answer back together.
 *
 * Shared by the normal path and the facilitator-unreachable one, which differ
 * only in whether anything is left to settle.
 */
function finishWith(
  entries: RpcRequest[],
  isBatch: boolean,
  blocked: Map<number, object>,
  settlers: Map<number, Settler>,
): Gate {
  const kept = entries.filter((_, i) => !blocked.has(i));

  const failedResult = (id: RpcRequest['id'], message: string) => ({
    jsonrpc: '2.0' as const,
    id,
    result: { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true },
  });

  return {
    body: isBatch ? kept : (kept[0] as RpcRequest),
    empty: kept.length === 0,

    async finish(dispatched) {
      // handleMcp returns a bare object for a single request and an array for a
      // batch, and drops notification entries — so positions do not survive it.
      // Rejoin on the JSON-RPC id, the only stable handle either side has.
      //
      // Its one hazard, stated rather than hidden: a batch that repeats an id
      // collapses onto one entry here, so the duplicates lose their answers.
      // That envelope is malformed under JSON-RPC 2.0 and no client sends it,
      // but it is the reason the obvious "pass a per-call context to handlers
      // and rejoin by position" refactor is not the improvement it looks like:
      // McpTool.handler is (args) => Promise<unknown> and widening it cannot
      // carry a settlement receipt back out, so the rejoin would still be here.
      const answers = dispatched == null ? [] : Array.isArray(dispatched) ? dispatched : [dispatched];
      const byId = new Map<unknown, Record<string, unknown>>(
        answers.map(a => [(a as { id?: unknown }).id, a as Record<string, unknown>]),
      );

      await Promise.all([...settlers].map(async ([index, settle]) => {
        const id = entries[index]!.id;
        const answer = byId.get(id);
        // No answer, a JSON-RPC error, or a handler that raised: the caller is
        // not getting the data, so nothing is charged for it.
        const failed = !answer
          || 'error' in answer
          || (answer.result as { isError?: boolean } | undefined)?.isError === true;
        if (failed) return;

        try {
          const receipt = await settle();
          if (receipt.success === false) {
            // Settlement failed after the handler ran. The bytes exist but must
            // not ship — nobody was charged for them.
            byId.set(id, failedResult(id, 'Payment settlement failed.'));
            return;
          }
          const result = answer.result as Record<string, unknown>;
          result._meta = { ...(result._meta as object), 'x402/payment-response': receipt };
        } catch {
          // Facilitator unreachable at settle time. Fail CLOSED: withholding a
          // bulk export costs a retry, and handing one over uncharged is what a
          // scraper waits for.
          byId.set(id, failedResult(id, 'Payment settlement is temporarily unavailable. Retry shortly.'));
        }
      }));

      // Rebuild in the caller's original order, challenges spliced back in.
      const merged = entries
        .map((e, i) => blocked.get(i) ?? byId.get(e.id))
        .filter(Boolean) as object[];

      return isBatch ? merged : (merged[0] ?? null);
    },
  };
}

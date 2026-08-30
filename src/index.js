/**
 * dsh-modelprint — a DeepSeek Harness function plugin that fingerprints each
 * request and diffs the live fingerprint against a pinned one.
 *
 * The card is five observable facts about a request: the provider, the model
 * **id**, the sampling that was asked for, a hash of the tool schemas the model
 * was actually offered, and a hash of the system-prompt prefix it was actually
 * given. On `agent/request` the plugin records that card; the one model-facing
 * tool, `modelprint_check`, compares it to a pinned JSON file and returns a
 * structured match or mismatch.
 *
 * **This is a fingerprint, not a watermark.** It catches an alias that started
 * resolving somewhere else, sampling that drifted, a tool that appeared or
 * vanished from the offered set, and a system prompt that changed underneath
 * you. It cannot catch weights a provider swapped behind a stable alias, and it
 * makes no claim to authenticate a model. See the README.
 *
 * The plugin registers exactly one tool against the `tools` service and owns
 * nothing else. Registration happens inside `apply` so the Cordis fiber owns
 * the effect: stopping, updating, or reloading the plugin unregisters the tool
 * with no bookkeeping here. Named exports preserve the loader's injection
 * metadata. Nothing here reaches a network or loads a model.
 *
 * @module dsh-modelprint
 */
import { resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  CARD_FIELDS,
  ModelprintError,
  PLUGIN_NAME,
  REASONS,
  checkPin,
  failedCheck,
  fingerprintRequest,
  getLiveCard,
  recordRequest,
  renderCheck,
} from './fingerprint.js'

export {
  CARD_FIELDS,
  ModelprintError,
  PLUGIN_NAME,
  REASONS,
  canonicalJson,
  checkPin,
  clearLiveCard,
  compareCards,
  failedCheck,
  fingerprintRequest,
  getLiveCard,
  hashSystemPrefix,
  hashTools,
  normalizeCard,
  normalizeSystemPrefix,
  normalizeTools,
  readPin,
  recordRequest,
  renderCheck,
  sha256Hex,
} from './fingerprint.js'

/** The one model-facing tool name this plugin owns. */
export const MODELPRINT_CHECK_TOOL_NAME = 'modelprint_check'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'modelprint'

/**
 * `tools` is a hard dependency: with no registry there is nothing for this
 * plugin to do, so it waits rather than degrading.
 */
export const inject = ['tools']

/** The pin file used when neither config nor environment names one. */
export const DEFAULT_PIN_PATH = 'modelprint.pin.json'

/**
 * The events the plugin records from, in preference order. `agent/request` is
 * the request as the agent assembled it; `llm/stream` carries the equivalent
 * `GenerateOptions` for a host that only emits the lower-level event. Both are
 * optional, and recording the same card twice is harmless.
 */
export const RECORDED_EVENTS = Object.freeze(['agent/request', 'llm/stream'])

/**
 * Resolve the plugin's effective settings.
 *
 * Precedence is patch config, then environment, then default — the patch row is
 * the deployment's stated intent, so it wins over an ambient variable.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @param env - Environment to read, injectable for tests.
 * @returns `{ pinPath }`, absolute.
 */
export function resolveConfig(config = {}, env = process.env) {
  return {
    pinPath: resolve(config.pinPath ?? env.DSH_MODELPRINT_PIN ?? DEFAULT_PIN_PATH),
  }
}

/**
 * The card fields as an output schema, restated for the `live` and `pinned`
 * members of a result.
 * @param description - What this particular card is.
 * @returns A closed object schema for one card.
 */
function cardSchema(description) {
  return {
    type: 'object',
    additionalProperties: false,
    description,
    properties: {
      provider: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'The provider named by the request, or null if it named none.',
      },
      model: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'The model id — the alias actually sent, not a marketing name.',
      },
      temperature: {
        oneOf: [{ type: 'number' }, { type: 'null' }],
        description: 'Sampling temperature, or null when the request asked for none.',
      },
      top_p: {
        oneOf: [{ type: 'number' }, { type: 'null' }],
        description: 'Nucleus sampling, or null. Never defaulted; recorded only if present.',
      },
      tools_hash: {
        type: 'string',
        required: true,
        description:
          'SHA-256 of the canonical tool list the model was offered, sorted by name so ' +
          'registration order cannot false-positive.',
      },
      system_prompt_prefix_hash: {
        type: 'string',
        required: true,
        description: 'SHA-256 of the normalized system-prompt prefix the model was given.',
      },
    },
  }
}

/**
 * Build the `modelprint_check` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time and each `apply` owns its own definition bound to
 * its own resolved config. Exported so a host can drive the tool without
 * booting a profile.
 * @param settings - Resolved settings from {@link resolveConfig}, plus the
 *   optional `readFile` seam.
 * @returns A registry-ready tool definition.
 */
export function createModelprintCheckTool(settings = {}) {
  return defineTool({
    name: MODELPRINT_CHECK_TOOL_NAME,
    description:
      'Compare the live model fingerprint card — provider, model id, temperature, top_p, a hash ' +
      'of the tool schemas this model was offered, and a hash of the system-prompt prefix it was ' +
      'given — against a pinned card stored as JSON, and report a structured match or mismatch ' +
      'naming every field that differs. Reach for it to verify that the alias, the sampling, the ' +
      'offered tools, and the system prompt have not drifted since the card was pinned, and when ' +
      'asked why behaviour changed between runs. It compares only what the request itself shows: ' +
      'it cannot detect weights a provider swapped behind a stable alias, and it is not model ' +
      'authentication. Changing the tool set or the system prompt on purpose will mismatch, which ' +
      'is the point — repin afterwards.',
    parameters: {
      pin: {
        type: 'string',
        description:
          'Path to the pinned card JSON. Defaults to the configured `pinPath`. A missing file ' +
          'is reported as PIN_MISSING rather than raised.',
      },
      request_json: {
        type: 'string',
        description:
          'A request object as a JSON string, fingerprinted for this call instead of using the ' +
          'last recorded live card. For a host that hooks no events, or to check a saved ' +
          'request. Unparseable JSON is reported as REQUEST_INVALID.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          match: {
            type: 'boolean',
            required: true,
            description: 'True only when every compared card field is equal.',
          },
          ok: {
            type: 'boolean',
            required: true,
            description: 'The same verdict as `match`, under the name a caller may expect.',
          },
          pin: {
            type: 'string',
            required: true,
            description: 'Absolute path of the pin file that was consulted.',
          },
          live: {
            oneOf: [cardSchema('The card fingerprinted from the live request.'), { type: 'null' }],
            description: 'The live card, or null when there was none to compare.',
          },
          pinned: {
            oneOf: [cardSchema('The card read from the pin file.'), { type: 'null' }],
            description:
              'The pinned card reduced to the documented fields, or null when the pin was ' +
              'missing or invalid. Extra keys in the pin file are ignored, not compared.',
          },
          mismatches: {
            type: 'array',
            required: true,
            description: 'One entry per differing field; empty on a match.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: {
                  type: 'string',
                  required: true,
                  enum: [...CARD_FIELDS],
                  description: 'The card field that differs.',
                },
                expected: {
                  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
                  description: 'What the pinned card says.',
                },
                actual: {
                  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
                  description: 'What the live card says.',
                },
              },
            },
          },
          reason: {
            type: 'string',
            required: true,
            enum: [...REASONS],
            description:
              'OK on a match; otherwise the failure, or the first differing field in compare ' +
              'order (model, provider, tools, system prompt, then sampling).',
          },
          detail: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Human-readable detail for the reason, or null on a match.',
          },
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
    },
    execute(args) {
      const pinPath = args.pin === undefined ? settings.pinPath : resolve(args.pin)

      let live = getLiveCard()
      if (args.request_json !== undefined) {
        let parsed
        try {
          parsed = JSON.parse(args.request_json)
        } catch (error) {
          return Promise.resolve(
            failedCheck(pinPath, 'REQUEST_INVALID', `request_json is not JSON: ${error.message}`),
          )
        }
        // Deliberately not `recordRequest`: a one-off check of a saved request
        // must not overwrite the card describing what the harness actually sent.
        try {
          live = fingerprintRequest(parsed)
        } catch (error) {
          if (error instanceof ModelprintError) {
            return Promise.resolve(failedCheck(pinPath, error.code, error.message))
          }
          throw error
        }
      }

      return Promise.resolve(checkPin(live, pinPath, { readFile: settings.readFile }))
    },
  })
}

/** The keys whose presence marks a value as a request rather than something else. */
const REQUEST_KEYS = Object.freeze([
  'provider',
  'model',
  'modelId',
  'model_id',
  'tools',
  'system',
  'systemPrompt',
  'system_prompt',
  'messages',
])

/**
 * Whether a value looks enough like a request to be worth fingerprinting.
 *
 * The event listeners are defensive on purpose: a waterfall handler may be
 * handed, or may return, something that is not the request at all, and a card
 * built from that would be a lie rather than a fingerprint.
 * @param value - The candidate.
 * @returns True when it carries at least one field a card reads.
 */
export function isRequestLike(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return REQUEST_KEYS.some((key) => Object.hasOwn(value, key))
}

/**
 * Record whichever of the waterfall's input and output is actually a request.
 *
 * The card should describe what will really be sent, so the value `next`
 * returns wins when it still looks like a request; otherwise the value handed
 * in is used. Either way the chain is passed through untouched.
 * @param value - The waterfall's input.
 * @param next - The rest of the chain, if the host supplied one.
 * @returns Whatever the chain returns, unchanged.
 */
function passThroughAndRecord(value, next) {
  const out = typeof next === 'function' ? next(value) : value
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    return out.then((settled) => {
      record(isRequestLike(settled) ? settled : value)
      return settled
    })
  }
  record(isRequestLike(out) ? out : value)
  return out
}

/**
 * Fingerprint and store a request, ignoring anything that is not one.
 * @param candidate - The value to record.
 */
function record(candidate) {
  if (isRequestLike(candidate)) recordRequest(candidate)
}

/**
 * Register the plugin's single tool, and start recording requests.
 *
 * The tool is registered unconditionally; the event listeners are attached only
 * if the host emits events at all. A host with neither can call `recordRequest`
 * itself, or pass `request_json` to the tool.
 *
 * The raw config is spread under the resolved settings so a host driving
 * `apply` directly can pass the `readFile` seam through it; a patch row, being
 * YAML, can only ever supply the documented keys.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param config - The `config` block of this plugin's row in the composed patch.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(createModelprintCheckTool({ ...config, ...resolveConfig(config) }))

  if (typeof ctx.on === 'function') {
    for (const event of RECORDED_EVENTS) {
      ctx.on(event, (value, next) => passThroughAndRecord(value, next))
    }
  }
}

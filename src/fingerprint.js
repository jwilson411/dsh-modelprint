/**
 * The pure half of dsh-modelprint: turn a request into a fingerprint card,
 * remember the last one, and diff it against a pinned card on disk.
 *
 * Nothing here touches Cordis, and nothing here reaches a network. The only
 * I/O is reading the pin file, and that failure is a value rather than a throw.
 *
 * **What a card is.** A card is the small set of facts about a request that a
 * caller can actually observe: which provider and model id were named, what
 * sampling was asked for, the schemas of the tools the model was offered, and
 * the system-prompt prefix it was given. It is a fingerprint of the request,
 * not of the weights — see the README for what that does and does not catch.
 *
 * @module dsh-modelprint/fingerprint
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The plugin's own identity, echoed on every result so a caller can confirm the source. */
export const PLUGIN_NAME = 'dsh-modelprint'

/**
 * The card's fields, in the order they are compared. A mismatch's `reason` is
 * derived from the first field in this order that differs, so the order is the
 * diagnosis priority: the alias first, then the offered surface, then sampling.
 */
export const CARD_FIELDS = Object.freeze([
  'model',
  'provider',
  'tools_hash',
  'system_prompt_prefix_hash',
  'temperature',
  'top_p',
])

/** Every `reason` a check can report. `OK` is the only one that means match. */
export const REASONS = Object.freeze([
  'OK',
  'MODEL_MISMATCH',
  'PROVIDER_MISMATCH',
  'TOOLS_HASH_MISMATCH',
  'SYSTEM_PROMPT_PREFIX_HASH_MISMATCH',
  'TEMPERATURE_MISMATCH',
  'TOP_P_MISMATCH',
  'PIN_MISSING',
  'PIN_INVALID',
  'NO_LIVE_CARD',
  'REQUEST_INVALID',
])

/** The `reason` reported for a difference in each card field. */
const MISMATCH_REASONS = Object.freeze({
  model: 'MODEL_MISMATCH',
  provider: 'PROVIDER_MISMATCH',
  tools_hash: 'TOOLS_HASH_MISMATCH',
  system_prompt_prefix_hash: 'SYSTEM_PROMPT_PREFIX_HASH_MISMATCH',
  temperature: 'TEMPERATURE_MISMATCH',
  top_p: 'TOP_P_MISMATCH',
})

/**
 * A fault this package raises rather than a bare `Error`, so a caller can
 * branch on `code` instead of parsing prose.
 */
export class ModelprintError extends Error {
  /**
   * @param code - A stable code from {@link REASONS}.
   * @param message - Human-readable detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ModelprintError'
    this.code = code
  }
}

/**
 * Recursively rewrite a value into its canonical form: object keys sorted by
 * UTF-16 code unit, `undefined` members dropped, array order preserved.
 * @param value - Any JSON-serializable value.
 * @returns The canonicalized value.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const member = canonicalize(value[key])
      if (member !== undefined) out[key] = member
    }
    return out
  }
  return value
}

/**
 * Encode a value as canonical JSON: UTF-8, object keys sorted, no insignificant
 * whitespace. Array order is preserved — callers that need order-insensitivity
 * (the tool list) sort before encoding.
 * @param value - Any JSON-serializable value.
 * @returns The canonical JSON text; `"null"` for `undefined`.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

/**
 * SHA-256 of a string's UTF-8 bytes.
 * @param text - The string to hash.
 * @returns Lowercase hex digest.
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Read the first present key from an object.
 * @param source - The object to read.
 * @param keys - Candidate keys, in precedence order.
 * @returns The first non-nullish value, else `undefined`.
 */
function pick(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Coerce a value to a finite number, or to null.
 * @param value - The candidate.
 * @returns The number, or null when absent or not finite.
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Coerce a value to a non-empty string, or to null.
 * @param value - The candidate.
 * @returns The string, or null.
 */
function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Pull display text out of one message-content shape.
 *
 * Accepts a plain string, an array of content blocks (`{ type: 'text', text }`
 * or bare strings), or an object carrying a `text` field. Anything else — an
 * image block, a tool result — contributes nothing, because it is not part of
 * the system-prompt prefix this package claims to hash.
 * @param content - The content to read.
 * @returns The concatenated text.
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') {
    return content.text
  }
  return ''
}

/**
 * Normalize the model-visible tool list into the canonical shape that is
 * hashed: `[{ name, description, parameters }, …]`, sorted by `name`.
 *
 * Registration order is not a fact about the model's surface, so it is sorted
 * away rather than allowed to false-positive. `execute` and any other function
 * member is dropped: the model never sees a function body, only a schema.
 *
 * Two input shapes are accepted:
 *
 * - an array of `{ name, description, parameters }`, or of the OpenAI-style
 *   `{ type: 'function', function: { name, description, parameters } }`
 * - a map of `{ [name]: descriptor }`. A descriptor carrying its own
 *   `parameters` key is read as `{ description, parameters }`; anything else is
 *   read as the parameters schema itself.
 *
 * @param tools - The tool list or map, or nothing.
 * @returns The canonical tool list, sorted by name.
 */
export function normalizeTools(tools) {
  const entries = []
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool === null || typeof tool !== 'object') continue
      const source = tool.function !== undefined && tool.function !== null ? tool.function : tool
      const toolName = asString(source.name)
      if (toolName === null) continue
      entries.push(normalizeTool(toolName, source.description, source.parameters))
    }
  } else if (tools !== null && typeof tools === 'object') {
    for (const [toolName, descriptor] of Object.entries(tools)) {
      if (descriptor === null || typeof descriptor !== 'object') {
        entries.push(normalizeTool(toolName, undefined, undefined))
      } else if (Object.hasOwn(descriptor, 'parameters')) {
        entries.push(normalizeTool(toolName, descriptor.description, descriptor.parameters))
      } else {
        entries.push(normalizeTool(toolName, undefined, descriptor))
      }
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Build one canonical tool entry.
 * @param toolName - The tool's name.
 * @param description - Its model-facing description, if any.
 * @param parameters - Its parameter schema, if any.
 * @returns `{ name, description, parameters }` with documented nulls.
 */
function normalizeTool(toolName, description, parameters) {
  return {
    name: toolName,
    description: typeof description === 'string' ? description : null,
    parameters: parameters === undefined ? null : canonicalize(parameters),
  }
}

/**
 * Hash the model-visible tool list.
 * @param tools - The tool list or map, or nothing.
 * @returns SHA-256 hex of the canonical JSON of {@link normalizeTools}'s output.
 *   No tools at all hashes the empty list, `[]`.
 */
export function hashTools(tools) {
  return sha256Hex(canonicalJson(normalizeTools(tools)))
}

/**
 * Extract the system-prompt prefix a request gave the model.
 *
 * The prefix is, in precedence order:
 *
 * 1. `system` / `systemPrompt` / `system_prompt` on the request, read as text;
 * 2. otherwise the *leading run* of `role: "system"` messages in `messages`
 *    (or `input`), joined with `\n` and stopping at the first message with
 *    another role — a system message injected mid-conversation is not a prefix.
 *
 * The result is normalized before hashing: CRLF and CR are folded to LF, and
 * leading and trailing whitespace is trimmed. Nothing else is touched, so a
 * changed word inside the prompt still changes the hash.
 * @param request - The request object.
 * @returns The normalized prefix; `''` when the request has no system text.
 */
export function normalizeSystemPrefix(request) {
  const source = request !== null && typeof request === 'object' ? request : {}
  const direct = pick(source, ['system', 'systemPrompt', 'system_prompt'])
  let text = direct === undefined ? '' : contentText(direct)

  if (text === '') {
    const messages = Array.isArray(source.messages)
      ? source.messages
      : Array.isArray(source.input)
        ? source.input
        : []
    const prefix = []
    for (const message of messages) {
      if (message === null || typeof message !== 'object' || message.role !== 'system') break
      prefix.push(contentText(message.content))
    }
    text = prefix.filter(Boolean).join('\n')
  }

  return text.replace(/\r\n?/g, '\n').trim()
}

/**
 * Hash a normalized system-prompt prefix.
 * @param prefix - The normalized prefix text.
 * @returns SHA-256 hex of its UTF-8 bytes. An absent prefix is the empty
 *   string, so it hashes to the SHA-256 of `''` rather than to a sentinel.
 */
export function hashSystemPrefix(prefix) {
  return sha256Hex(typeof prefix === 'string' ? prefix : '')
}

/**
 * Fingerprint a request into a card.
 *
 * Deterministic: the same request object always produces the same card, and no
 * field of the card depends on registration order, key order, or clock.
 *
 * `top_p` is recorded when the request carries it even though DSH's current
 * `GenerateOptions` has no such knob — recording it costs nothing and makes a
 * future knob, or another host's request, visible instead of silently ignored.
 * It is never defaulted: absent means null, and null pins as null.
 * @param request - The request, or the equivalent `GenerateOptions`.
 * @returns The card: `{ provider, model, temperature, top_p, tools_hash,
 *   system_prompt_prefix_hash }`, every key always present.
 * @throws {ModelprintError} `REQUEST_INVALID` when handed a non-object.
 */
export function fingerprintRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new ModelprintError(
      'REQUEST_INVALID',
      `expected a request object, got ${request === null ? 'null' : typeof request}`,
    )
  }
  return {
    provider: asString(pick(request, ['provider'])),
    model: asString(pick(request, ['model', 'modelId', 'model_id'])),
    temperature: asNumber(pick(request, ['temperature'])),
    top_p: asNumber(pick(request, ['top_p', 'topP'])),
    tools_hash: hashTools(pick(request, ['tools'])),
    system_prompt_prefix_hash: hashSystemPrefix(normalizeSystemPrefix(request)),
  }
}

/**
 * Reduce any object to the documented card fields, mapping absent to null.
 *
 * Extra keys on a pin file are dropped here rather than compared, so a pin can
 * carry a comment, a date, or a note without failing a check.
 * @param card - A card, or a pin file's contents.
 * @returns A card with exactly the documented keys.
 */
export function normalizeCard(card) {
  const source = card !== null && typeof card === 'object' ? card : {}
  return {
    provider: asString(source.provider),
    model: asString(source.model),
    temperature: asNumber(source.temperature),
    top_p: asNumber(source.top_p ?? source.topP),
    tools_hash: asString(source.tools_hash) ?? '',
    system_prompt_prefix_hash: asString(source.system_prompt_prefix_hash) ?? '',
  }
}

/**
 * Diff a live card against a pinned one, field by field.
 *
 * An absent field and a null field are the same thing: a pin that names no
 * temperature matches a request that asked for none.
 * @param live - The live card.
 * @param pinned - The pinned card.
 * @returns One `{ field, expected, actual }` per differing field, in
 *   {@link CARD_FIELDS} order. Empty means match.
 */
export function compareCards(live, pinned) {
  const a = normalizeCard(live)
  const b = normalizeCard(pinned)
  const mismatches = []
  for (const field of CARD_FIELDS) {
    if (a[field] !== b[field]) {
      mismatches.push({ field, expected: b[field], actual: a[field] })
    }
  }
  return mismatches
}

/** The last card {@link recordRequest} fingerprinted, module-scoped. */
let liveCard = null

/**
 * Fingerprint a request and remember it as the live card.
 *
 * A host with no events to hook can call this itself; the plugin calls it from
 * its `agent/request` listener.
 * @param request - The request, or the equivalent `GenerateOptions`.
 * @returns The card that was stored.
 * @throws {ModelprintError} `REQUEST_INVALID` when handed a non-object.
 */
export function recordRequest(request) {
  liveCard = fingerprintRequest(request)
  return liveCard
}

/**
 * The last recorded card.
 * @returns The card, or null if nothing has been recorded.
 */
export function getLiveCard() {
  return liveCard
}

/** Forget the last recorded card. Exists for tests and for host teardown. */
export function clearLiveCard() {
  liveCard = null
}

/**
 * Read a pinned card from disk.
 *
 * A missing file and unparseable JSON are values, not throws — the tool's
 * contract is a structured result either way.
 * @param pinPath - Absolute path to the pin file.
 * @param readFile - Reader seam, injectable for tests.
 * @returns `{ card }` on success, else `{ reason, detail }`.
 */
export function readPin(pinPath, readFile = readFileSync) {
  let text
  try {
    text = readFile(pinPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { card: null, reason: 'PIN_MISSING', detail: `no pin file at ${pinPath}` }
    }
    return { card: null, reason: 'PIN_MISSING', detail: `cannot read ${pinPath}: ${error?.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { card: null, reason: 'PIN_INVALID', detail: `${pinPath} is not JSON: ${error.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { card: null, reason: 'PIN_INVALID', detail: `${pinPath} is not a JSON object` }
  }
  return { card: parsed, reason: null, detail: null }
}

/**
 * Check a live card against a pinned card file.
 *
 * Every path returns the same shape, including every failure: a mismatch is a
 * structured result, not an exception and not prose.
 * @param live - The live card, or null when nothing was recorded.
 * @param pinPath - Absolute path to the pin file.
 * @param options - `{ readFile }` reader seam, injectable for tests.
 * @returns `{ match, ok, pin, live, pinned, mismatches, reason, detail, plugin }`.
 */
export function checkPin(live, pinPath, options = {}) {
  const base = { pin: pinPath, live: live === null || live === undefined ? null : normalizeCard(live) }

  if (base.live === null) {
    return result({
      ...base,
      pinned: null,
      mismatches: [],
      reason: 'NO_LIVE_CARD',
      detail:
        'no request has been fingerprinted yet — hook agent/request, or pass request_json to the tool',
    })
  }

  const pin = readPin(pinPath, options.readFile)
  if (pin.reason !== null) {
    return result({ ...base, pinned: null, mismatches: [], reason: pin.reason, detail: pin.detail })
  }

  const pinned = normalizeCard(pin.card)
  const mismatches = compareCards(base.live, pinned)
  return result({
    ...base,
    pinned,
    mismatches,
    reason: mismatches.length === 0 ? 'OK' : MISMATCH_REASONS[mismatches[0].field],
    detail:
      mismatches.length === 0
        ? null
        : `${mismatches.length} field(s) differ from the pinned card: ` +
          mismatches.map((m) => m.field).join(', '),
  })
}

/**
 * Stamp a check with its verdict and this plugin's name.
 * @param partial - Everything but `match`, `ok`, and `plugin`.
 * @returns The canonical result object.
 */
function result(partial) {
  const match = partial.reason === 'OK'
  return { match, ok: match, ...partial, plugin: PLUGIN_NAME }
}

/**
 * Build a check result for a failure that happens before any comparison — a
 * request fixture that will not parse, for instance.
 * @param pinPath - The pin path the call named.
 * @param reason - A reason from {@link REASONS}, never `OK`.
 * @param detail - Human-readable detail.
 * @returns The canonical result object, with null cards and no mismatches.
 */
export function failedCheck(pinPath, reason, detail) {
  return result({ pin: pinPath, live: null, pinned: null, mismatches: [], reason, detail })
}

/**
 * Project a check result into the one line the model reads.
 * @param value - A result from {@link checkPin}.
 * @returns A single line of text.
 */
export function renderCheck(value) {
  if (value.match) return 'modelprint: match'
  if (value.mismatches.length > 0) {
    return `modelprint: mismatch ${value.mismatches.map((m) => m.field).join(', ')}`
  }
  return `modelprint: fail ${value.reason}`
}

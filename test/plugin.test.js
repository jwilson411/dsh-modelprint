/**
 * The plugin seam: that `apply` registers the one tool, records what the host
 * emits, and that the tool the registry would get behaves the way its declared
 * contract says.
 *
 * `apply` is handed a stub context that records registrations and listeners,
 * and the tool is driven through the same `execute` the registry calls. No
 * profile boots, no socket opens, no key is read, and nothing is written.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  CARD_FIELDS,
  DEFAULT_PIN_PATH,
  MODELPRINT_CHECK_TOOL_NAME,
  PLUGIN_NAME,
  RECORDED_EVENTS,
  apply,
  clearLiveCard,
  createModelprintCheckTool,
  fingerprintRequest,
  getLiveCard,
  inject,
  isRequestLike,
  name,
  recordRequest,
  resolveConfig,
} from '../src/index.js'

import { PIN_FIXTURE, exec, fixtureRequest, loadJson, stubContext } from './helpers.js'

/**
 * Register the plugin and hand back its one tool.
 * @param config - The `config` block the patch row would supply.
 * @returns The registered tool and the stub's parts.
 */
function registerTool(config = { pinPath: PIN_FIXTURE }) {
  const parts = stubContext()
  apply(parts.ctx, config)
  assert.equal(parts.registered.length, 1)
  return { tool: parts.registered[0], ...parts }
}

/**
 * Validate a tool result against the tool's own declared output schema.
 * @param tool - The tool definition.
 * @param value - The result to check.
 */
function assertMatchesOutputSchema(tool, value) {
  assert.deepEqual(
    validateJsonSchemaValue(tool.output.schema, value, MODELPRINT_CHECK_TOOL_NAME),
    [],
  )
}

test('apply registers exactly one tool, named modelprint_check', () => {
  const { ctx, registered } = stubContext()

  apply(ctx, { pinPath: PIN_FIXTURE })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, MODELPRINT_CHECK_TOOL_NAME)
  assert.equal(name, 'modelprint')
  assert.equal(PLUGIN_NAME, 'dsh-modelprint')
  assert.deepEqual(inject, ['tools'])
})

test('the registered tool declares an object parameter schema, both arguments optional', () => {
  const { tool } = registerTool()

  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.required, undefined)
  // The parameter root is an implicit OPEN object: unknown keys are tolerated.
  assert.equal(tool.parameters.additionalProperties, undefined)
  assert.equal(tool.parameters.properties.pin.type, 'string')
  assert.equal(tool.parameters.properties.request_json.type, 'string')
  assert.ok(tool.description.length > 0)
  // The description must not oversell what a fingerprint can do.
  assert.match(tool.description, /cannot detect weights/)
})

test('the pin path defaults, then the environment sets it, then the patch row wins', () => {
  assert.equal(resolveConfig({}, {}).pinPath, resolve(DEFAULT_PIN_PATH))

  const env = { DSH_MODELPRINT_PIN: 'from/env.json' }
  assert.equal(resolveConfig({}, env).pinPath, resolve('from/env.json'))
  assert.equal(resolveConfig({ pinPath: 'from/patch.json' }, env).pinPath, resolve('from/patch.json'))
})

test('a match returns a value shaped by the declared output schema', async () => {
  clearLiveCard()
  recordRequest(fixtureRequest())
  const { tool } = registerTool()

  const value = await tool.execute({}, exec)

  assertMatchesOutputSchema(tool, value)
  assert.equal(value.match, true)
  assert.equal(value.ok, true)
  assert.equal(value.reason, 'OK')
  assert.equal(value.plugin, PLUGIN_NAME)
  assert.equal(value.pin, PIN_FIXTURE)
  assert.deepEqual(Object.keys(value.live).sort(), [...CARD_FIELDS].sort())
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: 'modelprint: match' }])
})

test('a mismatch returns a value shaped by the same schema, and is not thrown', async () => {
  clearLiveCard()
  recordRequest({ ...fixtureRequest(), model: 'deepseek-chat-v3', temperature: 0.9 })
  const { tool } = registerTool()

  const value = await tool.execute({}, exec)

  assertMatchesOutputSchema(tool, value)
  assert.equal(value.match, false)
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'MODEL_MISMATCH')
  assert.deepEqual(value.mismatches, [
    { field: 'model', expected: 'deepseek-chat', actual: 'deepseek-chat-v3' },
    { field: 'temperature', expected: 0.2, actual: 0.9 },
  ])
  assert.deepEqual(tool.output.render({}, value), [
    { type: 'text', text: 'modelprint: mismatch model, temperature' },
  ])
})

test('the pin argument overrides the configured path', async () => {
  clearLiveCard()
  recordRequest(fixtureRequest())
  const missing = join(tmpdir(), 'dsh-modelprint-absent', 'pin.json')
  const { tool } = registerTool({ pinPath: PIN_FIXTURE })

  const value = await tool.execute({ pin: missing }, exec)

  assertMatchesOutputSchema(tool, value)
  assert.equal(value.pin, missing)
  assert.equal(value.reason, 'PIN_MISSING')
})

test('a missing pin and no live card are structured fails, not thrown ENOENT', async () => {
  clearLiveCard()
  const missing = join(tmpdir(), 'dsh-modelprint-absent', 'pin.json')
  const { tool } = registerTool({ pinPath: missing })

  const noCard = await tool.execute({}, exec)
  assertMatchesOutputSchema(tool, noCard)
  assert.equal(noCard.reason, 'NO_LIVE_CARD')
  assert.equal(noCard.live, null)

  recordRequest(fixtureRequest())
  const noPin = await tool.execute({}, exec)
  assertMatchesOutputSchema(tool, noPin)
  assert.equal(noPin.reason, 'PIN_MISSING')
  assert.equal(noPin.pinned, null)
})

test('request_json checks a fixture without a prior record, and leaves the live card alone', async () => {
  clearLiveCard()
  const { tool } = registerTool()

  const value = await tool.execute({ request_json: JSON.stringify(fixtureRequest()) }, exec)

  assertMatchesOutputSchema(tool, value)
  assert.equal(value.match, true)
  // A one-off check must not become the recorded live card.
  assert.equal(getLiveCard(), null)
})

test('an unparseable request_json is REQUEST_INVALID, not a thrown SyntaxError', async () => {
  clearLiveCard()
  const { tool } = registerTool()

  const broken = await tool.execute({ request_json: '{ not json' }, exec)
  assertMatchesOutputSchema(tool, broken)
  assert.equal(broken.reason, 'REQUEST_INVALID')
  assert.equal(broken.match, false)

  const notAnObject = await tool.execute({ request_json: '"a request"' }, exec)
  assertMatchesOutputSchema(tool, notAnObject)
  assert.equal(notAnObject.reason, 'REQUEST_INVALID')
})

test('invalid arguments fail with ToolArgsError before the body runs', async () => {
  const { tool } = registerTool()

  for (const args of [{ pin: 7 }, { request_json: {} }, { pin: [] }, null, [], 'check']) {
    await assert.rejects(
      () => tool.execute(args, exec),
      (error) => {
        assert.ok(error instanceof ToolArgsError)
        assert.ok(error.violations.length > 0)
        return true
      },
      `expected ToolArgsError for ${JSON.stringify(args) ?? String(args)}`,
    )
  }
})

test('an argument the tool does not declare is tolerated, not refused', async () => {
  clearLiveCard()
  recordRequest(fixtureRequest())
  const { tool } = registerTool()

  const value = await tool.execute({ verbosity: 'high' }, exec)

  assertMatchesOutputSchema(tool, value)
  assert.equal(value.match, true)
})

test('apply with a stub ctx.on records an agent/request payload', () => {
  clearLiveCard()
  const { listeners } = registerTool()

  assert.deepEqual([...listeners.keys()], [...RECORDED_EVENTS])

  const request = fixtureRequest()
  const returned = listeners.get('agent/request')(request, (value) => value)

  assert.equal(returned, request)
  assert.deepEqual(getLiveCard(), fingerprintRequest(request))
})

test('the waterfall records what next returns, and never breaks the chain', () => {
  clearLiveCard()
  const { listeners } = registerTool()
  const rewritten = { ...fixtureRequest(), model: 'deepseek-reasoner' }

  const returned = listeners.get('agent/request')(fixtureRequest(), () => rewritten)

  assert.equal(returned, rewritten)
  assert.equal(getLiveCard().model, 'deepseek-reasoner')
})

test('an async waterfall records once it settles, and still resolves to its value', async () => {
  clearLiveCard()
  const { listeners } = registerTool()
  const request = fixtureRequest()

  const settled = await listeners.get('agent/request')(request, (value) => Promise.resolve(value))

  assert.deepEqual(settled, request)
  assert.deepEqual(getLiveCard(), fingerprintRequest(request))
})

test('llm/stream records the GenerateOptions and passes the stream through untouched', () => {
  clearLiveCard()
  const { listeners } = registerTool()
  const options = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.2,
    tools: fixtureRequest().tools,
    messages: fixtureRequest().messages,
  }
  const stream = { [Symbol.asyncIterator]: () => ({}) }

  const returned = listeners.get('llm/stream')(options, () => stream)

  // The chain's return value is a stream, not a request, so the options are
  // what gets fingerprinted — and the stream is handed back unchanged.
  assert.equal(returned, stream)
  assert.deepEqual(getLiveCard(), fingerprintRequest(options))
})

test('a value that is not a request is passed through and not recorded', () => {
  clearLiveCard()
  const { listeners } = registerTool()

  const returned = listeners.get('agent/request')({ unrelated: true }, (value) => value)

  assert.deepEqual(returned, { unrelated: true })
  assert.equal(getLiveCard(), null)
  assert.equal(isRequestLike({ unrelated: true }), false)
  assert.equal(isRequestLike(null), false)
  assert.equal(isRequestLike(['model']), false)
  assert.equal(isRequestLike({ model: 'deepseek-chat' }), true)
})

test('a host that emits no events still gets the tool', () => {
  const { ctx, registered } = stubContext({ events: false })

  apply(ctx, { pinPath: PIN_FIXTURE })

  assert.equal(registered.length, 1)
  assert.equal(ctx.on, undefined)
})

test('the readFile seam is honoured, so a check need not touch the disk', async () => {
  clearLiveCard()
  recordRequest(fixtureRequest())
  const tool = createModelprintCheckTool({
    ...resolveConfig({ pinPath: PIN_FIXTURE }),
    readFile: () => JSON.stringify(loadJson(PIN_FIXTURE)),
  })

  const value = await tool.execute({}, exec)

  assert.equal(value.match, true)
})

test('the manifest declares the bundle patch the profile installer looks for', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.name, PLUGIN_NAME)
  assert.equal(manifest.license, 'MIT')

  const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, new RegExp(`name: ${manifest.name}$`, 'm'))
  assert.match(patch, new RegExp(`id: ${name}$`, 'm'))
})

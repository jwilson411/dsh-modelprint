/**
 * The pure half: fingerprinting, canonical hashing, and the pin diff.
 *
 * These drive the library directly, without Cordis and without the tool. No
 * profile boots, no socket opens, no key is read; the only file touched is the
 * checked-in fixture pair and pins written under `os.tmpdir()`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CARD_FIELDS,
  ModelprintError,
  PLUGIN_NAME,
  canonicalJson,
  checkPin,
  clearLiveCard,
  compareCards,
  fingerprintRequest,
  getLiveCard,
  hashSystemPrefix,
  hashTools,
  normalizeSystemPrefix,
  normalizeTools,
  readPin,
  recordRequest,
  renderCheck,
  sha256Hex,
} from '../src/fingerprint.js'

import { PIN_FIXTURE, fixtureRequest, loadJson } from './helpers.js'

/**
 * Write a pin file into a fresh temporary directory.
 * @param card - The card, or any JSON value, to write.
 * @returns The absolute path written.
 */
function writePin(card) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-modelprint-'))
  const path = join(dir, 'modelprint.pin.json')
  writeFileSync(path, typeof card === 'string' ? card : JSON.stringify(card))
  return path
}

test('fingerprintRequest is deterministic on the checked-in fixture', () => {
  const first = fingerprintRequest(fixtureRequest())
  const second = fingerprintRequest(fixtureRequest())

  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first).sort(), [...CARD_FIELDS].sort())
  assert.deepEqual(first, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.2,
    top_p: 0.95,
    tools_hash: '841e5f224b75f50d46803f2b56e8205543d7bdbcadd6ba6341f7ec208302899f',
    system_prompt_prefix_hash:
      'd2c86f05836721d8eb82600a8c62b1e46b800e97d549759fdf36d8757c6cb20b',
  })
  // The pin fixture is the fingerprint of the request fixture.
  assert.deepEqual(compareCards(first, loadJson(PIN_FIXTURE)), [])
})

test('canonical JSON sorts object keys and drops insignificant whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  // Array order is meaningful and preserved; only tool lists are sorted, later.
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]')
  assert.equal(canonicalJson(undefined), 'null')
})

test('tool-list order does not change tools_hash', () => {
  const request = fixtureRequest()
  const reversed = { ...request, tools: [...request.tools].reverse() }

  assert.equal(fingerprintRequest(reversed).tools_hash, fingerprintRequest(request).tools_hash)
})

test('the map form of a tool list hashes the same as the array form', () => {
  const request = fixtureRequest()
  const asMap = Object.fromEntries(
    request.tools.map((tool) => [
      tool.name,
      { description: tool.description, parameters: tool.parameters },
    ]),
  )

  assert.equal(hashTools(asMap), hashTools(request.tools))
})

test('a changed schema, description, or tool set changes tools_hash', () => {
  const base = hashTools(fixtureRequest().tools)
  const tools = fixtureRequest().tools

  const renamedArg = structuredClone(tools)
  renamedArg[0].parameters.properties.path.type = 'number'
  assert.notEqual(hashTools(renamedArg), base)

  const redescribed = structuredClone(tools)
  redescribed[1].description = 'Something else entirely.'
  assert.notEqual(hashTools(redescribed), base)

  assert.notEqual(hashTools(tools.slice(0, 1)), base)
  assert.equal(hashTools(undefined), sha256Hex('[]'))
  assert.equal(hashTools([]), sha256Hex('[]'))
})

test('execute functions are not hashed: only the schema the model would see', () => {
  const withBodies = fixtureRequest().tools.map((tool) => ({ ...tool, execute: () => 'nope' }))

  assert.equal(hashTools(withBodies), hashTools(fixtureRequest().tools))
})

test('the system prefix is the leading run of system messages, normalized', () => {
  assert.equal(
    normalizeSystemPrefix(fixtureRequest()),
    'You are a careful assistant. Cite the file you read.',
  )
  // `system` outranks the message list.
  assert.equal(normalizeSystemPrefix({ system: 'direct', messages: [] }), 'direct')
  assert.equal(normalizeSystemPrefix({ systemPrompt: 'camel' }), 'camel')
  assert.equal(normalizeSystemPrefix({ system_prompt: 'snake' }), 'snake')
  // CRLF folds to LF and the ends are trimmed, so trivial reformatting is not drift.
  assert.equal(normalizeSystemPrefix({ system: '  a\r\nb \n' }), 'a\nb')
  // Content blocks are read for their text.
  assert.equal(
    normalizeSystemPrefix({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] }),
    'x',
  )
  // A system message after the first user turn is not a prefix.
  assert.equal(
    normalizeSystemPrefix({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'injected later' },
      ],
    }),
    '',
  )
})

test('an absent system prompt hashes the empty string, not a sentinel', () => {
  const card = fingerprintRequest({ provider: 'p', model: 'm' })

  assert.equal(card.system_prompt_prefix_hash, sha256Hex(''))
  assert.equal(card.system_prompt_prefix_hash, hashSystemPrefix(''))
  assert.equal(card.temperature, null)
  assert.equal(card.top_p, null)
})

test('top_p is recorded when present and never defaulted', () => {
  assert.equal(fingerprintRequest({ model: 'm', top_p: 0.1 }).top_p, 0.1)
  assert.equal(fingerprintRequest({ model: 'm', topP: 0.9 }).top_p, 0.9)
  assert.equal(fingerprintRequest({ model: 'm' }).top_p, null)
})

test('fingerprinting a non-object is a coded error, not a crash deep inside', () => {
  for (const bad of [null, 'a request', 42, ['request']]) {
    assert.throws(
      () => fingerprintRequest(bad),
      (error) => {
        assert.ok(error instanceof ModelprintError)
        assert.equal(error.code, 'REQUEST_INVALID')
        return true
      },
    )
  }
})

test('the live store holds the last recorded card and can be cleared', () => {
  clearLiveCard()
  assert.equal(getLiveCard(), null)

  const card = recordRequest(fixtureRequest())

  assert.deepEqual(getLiveCard(), card)
  recordRequest({ ...fixtureRequest(), model: 'deepseek-reasoner' })
  assert.equal(getLiveCard().model, 'deepseek-reasoner')

  clearLiveCard()
  assert.equal(getLiveCard(), null)
})

test('a matching card checks OK, and extra keys on the pin are ignored', () => {
  const live = fingerprintRequest(fixtureRequest())

  const value = checkPin(live, PIN_FIXTURE)

  assert.equal(value.match, true)
  assert.equal(value.ok, true)
  assert.equal(value.reason, 'OK')
  assert.deepEqual(value.mismatches, [])
  assert.equal(value.detail, null)
  assert.equal(value.pin, PIN_FIXTURE)
  assert.equal(value.plugin, PLUGIN_NAME)
  assert.equal(Object.hasOwn(value.pinned, '_note'), false)
  assert.equal(renderCheck(value), 'modelprint: match')
})

test('a different model id is a structured mismatch naming the field', () => {
  const live = fingerprintRequest({ ...fixtureRequest(), model: 'deepseek-chat-v3' })

  const value = checkPin(live, PIN_FIXTURE)

  assert.equal(value.match, false)
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'MODEL_MISMATCH')
  assert.deepEqual(value.mismatches, [
    { field: 'model', expected: 'deepseek-chat', actual: 'deepseek-chat-v3' },
  ])
  assert.equal(renderCheck(value), 'modelprint: mismatch model')
})

test('a changed tool set is a tools_hash mismatch', () => {
  const request = fixtureRequest()
  const live = fingerprintRequest({ ...request, tools: request.tools.slice(0, 1) })

  const value = checkPin(live, PIN_FIXTURE)

  assert.equal(value.match, false)
  assert.equal(value.reason, 'TOOLS_HASH_MISMATCH')
  assert.deepEqual(
    value.mismatches.map((m) => m.field),
    ['tools_hash'],
  )
  assert.equal(value.mismatches[0].expected, loadJson(PIN_FIXTURE).tools_hash)
  assert.equal(value.mismatches[0].actual, live.tools_hash)
})

test('a changed system prompt is a prefix-hash mismatch', () => {
  const live = fingerprintRequest({ ...fixtureRequest(), system: 'You are a reckless assistant.' })

  const value = checkPin(live, PIN_FIXTURE)

  assert.equal(value.match, false)
  assert.equal(value.reason, 'SYSTEM_PROMPT_PREFIX_HASH_MISMATCH')
  assert.deepEqual(
    value.mismatches.map((m) => m.field),
    ['system_prompt_prefix_hash'],
  )
})

test('a changed temperature is a sampling mismatch carrying both numbers', () => {
  const live = fingerprintRequest({ ...fixtureRequest(), temperature: 0.9 })

  const value = checkPin(live, PIN_FIXTURE)

  assert.equal(value.match, false)
  assert.equal(value.reason, 'TEMPERATURE_MISMATCH')
  assert.deepEqual(value.mismatches, [{ field: 'temperature', expected: 0.2, actual: 0.9 }])
  assert.equal(renderCheck(value), 'modelprint: mismatch temperature')
})

test('several differences are all reported, and the reason is the first in compare order', () => {
  const live = fingerprintRequest({
    ...fixtureRequest(),
    model: 'other',
    temperature: 0.9,
    tools: [],
  })

  const value = checkPin(live, PIN_FIXTURE)

  assert.deepEqual(
    value.mismatches.map((m) => m.field),
    ['model', 'tools_hash', 'temperature'],
  )
  assert.equal(value.reason, 'MODEL_MISMATCH')
  assert.equal(renderCheck(value), 'modelprint: mismatch model, tools_hash, temperature')
})

test('an absent sampling field and a null one are the same thing', () => {
  const request = { provider: 'deepseek', model: 'deepseek-chat' }
  const live = fingerprintRequest(request)

  const omitted = checkPin(live, writePin({ ...live, temperature: undefined, top_p: undefined }))
  const nulled = checkPin(live, writePin({ ...live, temperature: null, top_p: null }))

  assert.equal(omitted.match, true)
  assert.equal(nulled.match, true)
  // And a pin that does name a temperature still catches one that appears.
  const appeared = checkPin(fingerprintRequest({ ...request, temperature: 0.7 }), writePin(live))
  assert.equal(appeared.match, false)
  assert.deepEqual(appeared.mismatches, [{ field: 'temperature', expected: null, actual: 0.7 }])
})

test('a missing pin file is a structured fail, not an ENOENT', () => {
  const live = fingerprintRequest(fixtureRequest())
  const absent = join(tmpdir(), 'dsh-modelprint-does-not-exist', 'modelprint.pin.json')

  const value = checkPin(live, absent)

  assert.equal(value.match, false)
  assert.equal(value.reason, 'PIN_MISSING')
  assert.equal(value.pin, absent)
  assert.equal(value.pinned, null)
  assert.deepEqual(value.mismatches, [])
  assert.match(value.detail, /no pin file at/)
  assert.equal(renderCheck(value), 'modelprint: fail PIN_MISSING')
})

test('an unparseable or non-object pin is PIN_INVALID', () => {
  const live = fingerprintRequest(fixtureRequest())

  const broken = checkPin(live, writePin('{ not json'))
  assert.equal(broken.reason, 'PIN_INVALID')
  assert.equal(broken.pinned, null)

  const array = checkPin(live, writePin('["a card?"]'))
  assert.equal(array.reason, 'PIN_INVALID')
  assert.equal(renderCheck(array), 'modelprint: fail PIN_INVALID')
})

test('no live card is a structured fail rather than a comparison against nothing', () => {
  const value = checkPin(null, PIN_FIXTURE)

  assert.equal(value.match, false)
  assert.equal(value.reason, 'NO_LIVE_CARD')
  assert.equal(value.live, null)
  assert.equal(value.pinned, null)
  assert.equal(renderCheck(value), 'modelprint: fail NO_LIVE_CARD')
})

test('readPin reports its two failures as values and never throws', () => {
  assert.equal(readPin(join(tmpdir(), 'dsh-modelprint-nope.json')).reason, 'PIN_MISSING')
  assert.equal(readPin(writePin('nope')).reason, 'PIN_INVALID')
  assert.deepEqual(readPin(PIN_FIXTURE).reason, null)
})

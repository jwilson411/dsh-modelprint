/** Shared fixtures and stubs. Everything here is offline and synchronous. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Absolute path of the checked-in request fixture. */
export const REQUEST_FIXTURE = fileURLToPath(new URL('./fixtures/request.json', import.meta.url))

/** Absolute path of the checked-in pin fixture, which matches the request fixture. */
export const PIN_FIXTURE = fileURLToPath(new URL('./fixtures/pin.json', import.meta.url))

/**
 * Read a JSON fixture fresh, so a test that mutates its copy cannot leak into
 * the next one.
 * @param path - Absolute path to the fixture.
 * @returns The parsed fixture.
 */
export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The checked-in request, freshly parsed.
 * @returns A fake `agent/request` payload.
 */
export function fixtureRequest() {
  return loadJson(REQUEST_FIXTURE)
}

/**
 * A context stub exposing only what `apply` is allowed to touch.
 *
 * `on` records listeners so a test can fire an event by hand; omit it to model
 * a host that emits nothing.
 * @param options - `{ events }`, false to leave `ctx.on` undefined.
 * @returns The stub context, the definitions it recorded, and its listeners.
 */
export function stubContext({ events = true } = {}) {
  const registered = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  if (events) {
    ctx.on = (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    }
  }
  return { ctx, registered, listeners }
}

/** The execution context the registry passes to `execute`; unused by this tool. */
export const exec = { signal: new AbortController().signal }

# dsh-modelprint

A **DeepSeek Harness function plugin** that fingerprints each request into a
small **card** — the provider, the model **id**, the sampling that was asked
for, a hash of the tool schemas the model was actually offered, and a hash of
the system-prompt prefix it was actually given — and diffs that live card
against a **pinned** one on disk through one model-facing tool,
`modelprint_check`.

The scope is one question: **is this the same setup as last time?** Pin the
card when a run is known good; afterwards the tool answers with a structured
match, or names every field that drifted. It reaches no network, loads no
model, and needs no key — the only I/O is reading the pin file.

## What it is not

- **Not a watermark.** Nothing is embedded in a prompt or recovered from an
  output. The card is built from the request the harness assembled, and it is
  only ever compared against a file you wrote.
- **Not a weight-swap detector.** A provider that changes the weights behind a
  stable alias produces a byte-identical card. This catches what the *request*
  shows; it cannot see behind the alias.
- **Not a model-auth product.** There is no attestation, no signature, and no
  challenge — a matching card is evidence that your side of the call did not
  change, not proof of what answered it.

None of this is an accusation. The common cause of drift is your own repo: a
tool got registered, a system prompt got edited, someone set a temperature in a
patch layer. That is exactly the class of change this makes visible.

**It will false-positive the moment you change tools or the system prompt on
purpose — that is the point.** A deliberate change and an unnoticed one look
identical from inside the process, so the plugin reports both and lets you
judge. Re-pin afterwards and the noise stops.

## Install

```sh
dsh plugin --profile web add github:jwilson411/dsh-modelprint
```

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/web`, then reconciles
the profile: because this package's manifest declares `dsh.bundle.patch`, it is
appended to the profile manifest's ordered `dsh.profile.bundles` list and its
`cordis.patch.yml` becomes a layer. Remove it the same way, with `remove` in
place of `add`.

## Pinned DSH release candidate

This package is written and tested against the pinned release candidate
**`0.1.1-rc.2`** — `@deepseek-ai/dsh-tools@0.1.1-rc.2` is pinned exactly in
`devDependencies` so tests run against one known API, and the peer range is
`^0.1.1-rc.2`, matching how the harness's own tool packages declare it.

Note that `@deepseek-ai/dsh-tools`'s npm `latest` tag still points at the older
`0.0.1-rc.1`; the `0.1.1-rc.2` line is published under `next`. Pin explicitly
rather than relying on the tag.

## What it registers

| | |
|---|---|
| Cordis plugin id | `modelprint` (the row id in `cordis.patch.yml`) |
| Injects | `tools` — a hard dependency; the plugin waits rather than degrading |
| Tool | `modelprint_check` |
| Arguments | `pin` (string, optional), `request_json` (string, optional) |

`pin` defaults to the configured pin path. `request_json` fingerprints a saved
request for that one call *instead of* the live card, and deliberately does not
overwrite it — a one-off check must not clobber the card describing what the
harness actually sent.

Every path returns the same shape, including every failure: `{ match, ok, pin,
live, pinned, mismatches, reason, detail, plugin }`. A missing pin file is
`PIN_MISSING`, not a thrown `ENOENT`; unparseable JSON is `PIN_INVALID`; a
check before anything was recorded is `NO_LIVE_CARD`. `reason` is `OK` on a
match, otherwise the first differing field in compare order — model, provider,
tools, system prompt, then sampling — so the diagnosis leads with the alias
rather than with a temperature.

## The card

| field | from the request | notes |
|---|---|---|
| `provider` | `provider` | null when the request named none |
| `model` | `model` / `modelId` / `model_id` | the id actually sent, not a marketing name |
| `temperature` | `temperature` | null when none was asked for |
| `top_p` | `top_p` / `topP` | recorded only if present; never defaulted |
| `tools_hash` | `tools` | SHA-256 of the canonical tool list |
| `system_prompt_prefix_hash` | see below | SHA-256 of the normalized prefix |

`top_p` is recorded even though DSH's current `GenerateOptions` has no such
knob: it costs nothing, and it makes a future knob — or another host's request
— visible instead of silently ignored. Absent pins as null, and null matches
null, so a pin that names no temperature matches a request that asked for none.
Extra keys in a pin file (a date, a comment, a note) are dropped rather than
compared.

### `tools_hash` sorts by name

The tool list is normalized to `[{ name, description, parameters }, …]` and
**sorted by `name`** before hashing. Registration order is not a fact about the
model's surface, so it is sorted away rather than allowed to false-positive —
two profiles that register the same tools in different orders hash the same.
Functions are dropped: the model never sees an `execute` body, only a schema.
Both an array (plain, or OpenAI-style `{ type: 'function', function: {…} }`)
and a `{ [name]: descriptor }` map are accepted. No tools at all hashes the
empty list, `[]`.

### System-prefix normalization

The prefix is, in precedence order:

1. `system` / `systemPrompt` / `system_prompt` on the request, read as text; or
2. the **leading run** of `role: "system"` messages in `messages` (or `input`),
   joined with `\n` and stopping at the first message with another role — a
   system message injected mid-conversation is not a prefix and is not hashed.

Content is read from a plain string, an array of blocks (`{ type: 'text', text
}` or bare strings), or an object with a `text` field; anything else — an
image, a tool result — contributes nothing. The text is then normalized before
hashing: **CRLF and CR fold to LF, and leading and trailing whitespace is
trimmed.** Nothing else is touched, so a changed word inside the prompt still
changes the hash, while a file that crossed platforms does not.

A request with no system text has the prefix `''`, which hashes to the SHA-256
of the empty string — `e3b0c442…` — rather than to a sentinel. Same for an
empty tool list: absent and empty are the same observable fact, and both hash
to a real digest.

## Pinning

A pin is a JSON file holding the card you want to hold the run to:

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "temperature": 0.2,
  "top_p": null,
  "tools_hash": "841e5f22…",
  "system_prompt_prefix_hash": "d2c86f05…"
}
```

See [`examples/modelprint.pin.json`](examples/modelprint.pin.json) for a
complete one. The easiest way to write the first pin is to call
`modelprint_check` once against a path that does not exist and copy the `live`
card out of the `PIN_MISSING` result.

Where the file is read from, in precedence order:

| source | |
|---|---|
| `config.pinPath` | the plugin row's `config` in the composed patch |
| `DSH_MODELPRINT_PIN` | environment fallback |
| `modelprint.pin.json` | default, relative to the working directory |

The path is resolved absolute either way, and the patch row wins over the
environment: a patch row is the deployment's stated intent, so it should not be
silently overridden by an ambient variable.

Set it from the profile's own `cordis.patch.yml` — note that an id-targeted
patch replaces the row's whole `config`, so restate every field you mean to
keep:

```yaml
- id: modelprint
  config:
    pinPath: ./modelprint.pin.json
```

The bundle's own row carries no `config` on purpose: a profile that pins
nothing still gets the fingerprint recorded, and still gets a structured
`PIN_MISSING` from the tool.

## How the live card gets recorded

The plugin records on **`agent/request`** — the request as the agent assembled
it — and, for a host that only emits the lower-level event, on **`llm/stream`**,
which carries the equivalent `GenerateOptions`. Both are optional and recording
the same card twice is harmless.

Each listener is a pass-through: it calls the rest of the waterfall, records
whichever of the input and the output still looks like a request — the value
`next` returns wins, since the card should describe what will really be sent —
and returns the chain's value untouched. A value that carries none of the
fields a card reads is ignored rather than fingerprinted into a lie.

A host that emits neither event has two ways in, and needs no events at all:

```js
import { recordRequest } from 'dsh-modelprint'

recordRequest(request) // returns the card it stored
```

or pass the request to the tool as `request_json` for a single check.

## Layout

```
package.json          manifest + `dsh.bundle.patch` — what makes this a bundle
cordis.patch.yml      the bundle's patch layer: one insert, one plugin row
src/fingerprint.js    the pure half: cards, hashes, the pin file, the diff
src/index.js          the plugin: `name`, `inject`, `apply(ctx, config)`, the tool
examples/             a pin file to copy
test/                 offline tests over checked-in fixtures
package-lock.json     the pinned dependency tree `npm ci` installs in CI
```

## Tests

```sh
npm install
npm test
```

Offline by construction. The fingerprint half imports nothing outside `node:`
and this package, and its file reads go through an injected `readFile` seam, so
the missing-pin and invalid-pin paths are exercised without touching a disk.
`apply` is handed a stub context that records registrations and event
listeners, and the tool is driven through the same `execute` the registry
calls, with results validated against the real `@deepseek-ai/dsh-tools` pinned
to `0.1.1-rc.2`. No profile boots, no socket opens, no key is read.

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on Node 22 and 24
from the committed lockfile, against the public registry only. It needs no
credentials and the suite reaches no network.

## Out of scope

- **Detecting a weight swap.** Covered above: identical request, identical
  card.
- **Watermarking or output forensics.** Nothing is embedded and no response
  text is read.
- **Authenticating a provider.** No signatures, no attestation, no challenge.
- **Storing history.** One live card in memory and one pinned card on disk.
  There is no ledger, no sidecar, and no state to migrate.
- **Deciding for you.** The tool reports a mismatch; whether that is drift or
  the change you just made is a judgment it does not attempt.

## License

MIT — see [LICENSE](LICENSE).

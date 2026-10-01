# RelayAB Documentation

> **Language / 语言: English (this page) · [中文)](../zh/README.md)** — the switch
> lives only at the top level of each language track; individual pages link
> within their own language and will not send you into the other one.

Technical documentation for RelayAB, a self-hosted AI API gateway.

> **Language note.** Everything in this directory is in English, with one
> deliberate exception: the [media adapter protocol)](../模型适配协议/README.md) is
> maintained in **Chinese only**. It is the normative source for the declarative
> JSON spec format, and it is deliberately not translated — a spec-writing tool
> needs its rules stated in one language only, without translation drift between
> the document and the validator that enforces it.

## Where to start

| If you want to… | Read |
| --- | --- |
| Understand how the whole thing fits together | [architecture.md](architecture.md) |
| Know what a table, a field or an index means | [data-model.md](data-model.md) |
| Call an endpoint, or add one | [api-routes.md](api-routes.md) |
| Deploy it to your own server | [deployment.md](deployment.md) |
| Manage users, keys, and providers | [admin.md](admin.md) |
| Run or extend the test suite | [testing.md](testing.md) |
| Add an image / video / speech / music provider | [模型适配协议/README.md)](../模型适配协议/README.md) — **Chinese only** |

## Documents

| Document | Contents |
| --- | --- |
| [architecture.md](architecture.md) | Goals and non-goals, top-level architecture, the design decisions behind them, encryption and security |
| [data-model.md](data-model.md) | Tables and column names, every entity and its fields, indexes and unique constraints |
| [api-routes.md](api-routes.md) | Every public proxy endpoint, every admin API, middleware behaviour |
| [deployment.md](deployment.md) | Self-hosted architecture, database choice, first run, the smoke-test checklist, troubleshooting |
| [admin.md](admin.md) | The admin panel, end to end: users, keys, providers, error codes, debugging |
| [testing.md](testing.md) | The test pyramid, the tools, how to run each layer |
| [模型适配协议/README.md)](../模型适配协议/README.md) | **Chinese only.** The media adapter protocol: spec format, every primitive, the offline validator ("the judge"), and worked examples |

## Conventions used across these documents

- **Section numbers are stable.** Code comments cite them, e.g.
  `src/lib/db/users.ts` refers to `docs/en/data-model.md` §1 and
  `src/lib/crypto/password.ts` refers to `docs/en/deployment.md` §3. Renumbering a
  section breaks those references. One pre-existing gap is left alone on
  purpose: `data-model.md` has no §7 (it jumps from 6 to 8).
- **Code is never translated.** Identifiers, file paths, environment variables,
  route paths, JSON keys, and command flags are byte-identical to the source.
- **Terminology is pinned.** `provider` always means an upstream provider row,
  `customer API key` always means a key created in the panel, `quota` and
  `credits` are distinct (a quota is denominated in credits).
- **`⚠️` marks a trap, `⭐` marks a recommendation.**

## Related

- [zh/README.md)](../zh/README.md) — the Chinese documentation index
- [README.md](../../README.md) — the Chinese README (original)
- [README.en.md](../../README.en.md) — the English README

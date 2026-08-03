# CI

`ci.yml` is **active**, at `.github/workflows/ci.yml`. It ran dormant in
this folder while it was being built; it now runs on every push and pull
request. This folder keeps the notes.

Verified before activation from a CLEAN checkout (`rm -rf node_modules
package-lock.json && npm install && npm test`): 13/13 green. That matters
here more than usual — this repo could not install at all until the
dependency fix in this branch, so "it passes locally" had to mean
"it passes from nothing".

## What runs

`npm install` → `npm test`, on every push and pull request.

There is no build step (the package ships plain JS) and no coverage gate.
`npm install` rather than `npm ci`, because `package-lock.json` is
gitignored here and `npm ci` requires a committed lockfile.

## Will it pass today? Yes

**13 tests, all passing.** Verified from a clean checkout: `rm -rf node_modules package-lock.json
&& npm install && npm test`.

Nothing needs credentials or secrets.

## Why seneca-browser is pinned to an exact 8.0.0-rc2

Not a preference — **8.0.0-rc3 and -rc4 are broken** on the error path:

```
TypeError: Cannot read properties of null (reading 'errline')
    at Object.a [as error] (node_modules/seneca-browser/seneca-browser.js:285)
    at __intern.act_error (...)
    at outward_act_error (...)
```

Bisected across the published releases:

| version | result |
|---|---|
| 8.0.0-rc1 | passes |
| **8.0.0-rc2** | **passes — pinned here** |
| 8.0.0-rc3 | fails |
| 8.0.0-rc4 | fails |

So the regression landed in rc3. The failing test is the one driving an
**error flow** through a live bus — in this repo and in its sibling, the
same single test. Skipping it was the wrong fix: it is the only coverage
of error propagation through the bus, which is what these packages exist
to handle. Pinning to the last good release keeps that coverage.

The pin is **exact**, not a range, so a `^` cannot drag rc3/rc4 back in.

Raise the bug upstream against `seneca-browser`. When a release fixes
that path, move the pin forward and delete this section.

## What was fixed to get this far

`package.json` declared `"@seneca/browser": "^8.0.0rc4"`. That package
name **does not exist on npm** — a 404 on the name itself, not just the
version — and the version string was malformed too (`8.0.0rc4`, missing
the hyphen). `npm install` therefore failed outright, so the suite could
never run in a clean checkout; it only worked for a developer who
happened to have `voxgig/seneca-browser` cloned as a sibling directory,
which the test falls back to.

The published package is **unscoped**: `seneca-browser`. It is now a
devDependency, and the test resolves it as follows:

1. `@seneca/browser` — kept first, in case that name is ever published
2. `seneca-browser` — the package that actually exists
3. `../../seneca-browser/seneca-browser.js` — the sibling checkout, only
   if neither package is installed

## Testing against a sibling checkout

Set `SENECA_BROWSER_SIBLING=1`:

```bash
SENECA_BROWSER_SIBLING=1 npm test
```

This is an **explicit opt-in**, and an earlier version of this change got
it wrong. The fallback chain alone does not do it: once `seneca-browser`
is a real devDependency, step 2 always resolves after `npm install`, so
step 3 became unreachable and the sibling could never be exercised —
while the docs claimed otherwise.

Implicitly preferring the sibling would be worse: it would silently
defeat the version pin for anyone who happens to have that directory two
levels up, which is exactly how you end up back on the broken rc3/rc4
without noticing.

Note also that presence is decided by `require.resolve()`, with the
`require()` itself outside the `try`. A package that is found but throws
while **evaluating** — a missing transitive dependency, an incompatible
runtime — now surfaces that error instead of being silently mistaken for
"not installed" and falling through to a sibling that may not exist.

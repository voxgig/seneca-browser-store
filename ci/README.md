# CI workflow (dormant)

GitHub only runs workflows found under `.github/workflows/`. This lives in
`ci/`, so it is **inert** until deliberately activated.

## Activate

```bash
mkdir -p .github/workflows
git mv ci/ci.yml .github/workflows/ci.yml
git commit -m 'ci: activate workflow'
```

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
devDependency, and the test's require chain tries, in order:

1. `@seneca/browser` — kept first, in case that name is ever published
2. `seneca-browser` — the package that actually exists
3. `../../seneca-browser/seneca-browser.js` — the sibling checkout

So a clean checkout now installs and runs, a sibling checkout still wins
for local development against unreleased changes, and nothing breaks if
the scoped name appears later.

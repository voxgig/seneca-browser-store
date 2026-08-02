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

## Will it pass today? NO — one test fails

**13 tests, 12 pass, 1 fails.**

The failure is **not in this repo's code**. It is an upstream bug in
`seneca-browser@8.0.0-rc4`, on the error path:

```
TypeError: Cannot read properties of null (reading 'errline')
    at Object.a [as error] (node_modules/seneca-browser/seneca-browser.js:285)
    at __intern.act_error (...)
    at outward_act_error (...)
```

Both this repo and its sibling `@voxgig/seneca-browser-debug` fail exactly
one test each, in both cases the one that drives an **error flow** through
a live bus. Everything else passes.

Fix it upstream in `seneca-browser`, or pin to a release where that path
works. Do **not** skip the test to make CI green — it is the only coverage
of error propagation through the bus, which is precisely what this package
exists to capture.

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

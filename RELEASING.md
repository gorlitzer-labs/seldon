# Releasing

Every npm package in this repo is published by `.github/workflows/publish.yml`
and by nothing else. There is no npm token anywhere — not in this repo, not in
its secrets, not on a laptop. npm checks GitHub's signed identity for that
workflow instead ([trusted publishing](https://docs.npmjs.com/trusted-publishers)),
and attaches provenance, so every version links back to the commit it came from.

## Release a package

1. Bump the version on a branch and merge it to main, like any change:
   `cd modules/comb && npm version 0.2.1 --no-git-tag-version`
2. Tag that commit on main as `<package>@<version>` and push the tag:

   ```bash
   git checkout main && git pull
   git tag comb@0.2.1 && git push origin comb@0.2.1
   ```

The workflow refuses a tag whose version does not match `package.json`, or that
is not on main, then installs, builds, tests and publishes.

| tag prefix | package | directory |
|---|---|---|
| `comb@` | `@gorlitzer-labs/comb` | `modules/comb` |
| `factory@` | `@gorlitzer-labs/factory` | `modules/factory` |
| `foundation@` | `@gorlitzer-labs/foundation` | `modules/foundation` |
| `apiary@` | `@gorlitzer-labs/apiary` | `modules/apiary` |
| `seldon@` | `@gorlitzer-labs/seldon` | `tools/seldon` |

## One-time setup per package

Each package must name this workflow as its trusted publisher. With npm 11.15+
and 2FA on the account (the first command asks for it; allow the 5-minute skip
to do the rest in one go):

```bash
for p in comb factory foundation apiary seldon; do
  npm trust github "@gorlitzer-labs/$p" --repo gorlitzer-labs/seldon --file publish.yml --allow-publish --yes
done
```

A new package also needs a `repository` field pointing at this repo (with its
`directory`); npm rejects a trusted publish whose `repository.url` does not
match the repo the workflow runs in.

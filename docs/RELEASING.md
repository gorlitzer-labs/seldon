# Releasing

The Node packages (`@gorlitzer-labs/{apiary,foundation,comb,factory}` and the
`@gorlitzer-labs/seldon` installer) publish to **public npm**. bifrost ships via
its curl installer; demerzel is run from source — neither is on npm.

## One-time setup

Store an npm **Automation** token (long-lived, no 2FA prompt) in comb — once:

```bash
comb set NPM_TOKEN --url https://www.npmjs.com/settings/gorlitzer-labs/tokens
```

The root `.npmrc` is `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` (gitignored),
so the token is only ever injected at publish time — never written to disk.

## Every release

1. **Bump** the packages you changed (one command each):

   ```bash
   node tools/seldon/scripts/bump.mjs apiary patch    # or minor|major
   node tools/seldon/scripts/bump.mjs comb patch
   ```

2. **Commit** the bumps (via a PR to `main`, per the repo's flow).

3. **Publish** — idempotent, so it only ships versions not yet on npm:

   ```bash
   comb run --with NPM_TOKEN -- node tools/seldon/scripts/publish-all.mjs
   ```

   Add `--dry-run` to rehearse. Packages whose current version is already on
   npm are skipped, so it's always safe to run.

4. **Verify**:

   ```bash
   npm view @gorlitzer-labs/apiary version
   ```

That's it — bump, publish, done. The token lives in comb, so it never expires
out of your `~/.npmrc` again.

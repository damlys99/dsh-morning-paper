# Publishing

`dsh-morning-paper` is a dual-face DSH plugin: a host module and a browser
bundle in one npm package. Publishing is `npm publish`; the only DSH-specific
part is that the package must keep its `dsh.bundle` manifest so
`dsh plugin add` can wire it into a profile.

This file is **not** in the published tarball (`files` in `package.json`
excludes it) — it is a maintainer note.

## 1. Before the first publish

```sh
node selftest.mjs              # 124 assertions, no network, no browser
node verify-real-log.mjs       # exercises the core on real session logs
npm pack --dry-run             # confirm exactly which files ship
```

Check the manifest one more time:

- `name`, `version`, `description`, `license`, `repository`, `homepage`, `bugs`
- `dsh.bundle.patch` points at `./cordis.patch.yml`, which inserts the row
- `dsh.client.platform` is `web` and `dsh.client.inject` names the conversation
  package whose slot this plugin renders into
- `exports` maps `.`, `./briefing` and `./client` to files that exist — the
  client entry must stay exported, because that is what the browser module
  loader resolves to build the plugin's bundle

## 2. Log in and publish

```sh
npm login                     # once per machine
npm publish                   # publishConfig.access is already "public"
```

If the account enforces 2FA, npm prompts for an OTP. To publish a scoped or
prerelease build instead:

```sh
npm publish --tag next        # prerelease channel
```

Verify:

```sh
npm view dsh-morning-paper version
npm view dsh-morning-paper dsh
```

## 3. Publish a new version

```sh
npm version patch             # or minor / major; commits and tags for you
git push --follow-tags
npm publish
```

Update `CHANGELOG.md` before the version bump, and keep
`BRIEFING_VERSION` in `lib/briefing.js` meaningful: bump it when the briefing
document's shape changes incompatibly, not on every release.

## 4. Installation after publishing

```sh
dsh plugin --profile web add -w dsh-morning-paper
# restart dsh web, then reload the page
```

A restart is required: the host module and the client bundle are both composed at
boot, and `patchReload: live` only watches patch files.

## 5. Getting listed

The community list at
[awesome-dsh-plugins](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
accepts pull requests. For `dsh-morning-paper`, the entry goes under
**UI Enhancements**, and the criteria are that `dsh plugin add` installs it, the
description matches what the code does, and the repository is maintained. The
`dsh-plugin` topic on the GitHub repo is what the automated greps look for.

Keep the `dsh-plugin` badge and the topic on the repository, and make sure the
README's first paragraph says what the plugin does in one sentence — that
sentence is what a listing shows.

## Notes

- There is no build step and no runtime dependency. `lib/` is the shipped source;
  the browser bundle is hand-authored against the module-loader contract, so
  there is no bundler in the publish path.
- `verify-real-log.mjs` shells out to the `zstd` CLI. That is a dev tool; the
  plugin itself reads sessions through `ctx.sessionQuery` and never touches the
  on-disk format.
- The route answers on the loopback interface without the GUI's session cookie,
  in line with the rest of the plugin HTTP surface. It returns session-derived
  content, so if you ever bind DSH's port beyond loopback, treat it as
  trusted-network-only — and say so in the README of anything you publish.

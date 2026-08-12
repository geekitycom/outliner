# outline-components

A pnpm monorepo for the **Outliner** component — a TypeScript port of
[Concord](https://github.com/scripting/concord), a keyboard-driven OPML outliner — and the
apps built on it.

GPL-3.0, same as the upstream project. See `LICENSE.txt`.

## Layout

```
packages/
  outliner/    @andrewshell/outliner — the library, its demo, unit tests, and e2e suite
apps/
  desktop/     GeekityFlow — a Tauri desktop app that wraps the component (see apps/desktop/README.md)
```

## Getting started

```bash
pnpm install       # once, at the root
pnpm dev           # the outliner demo at http://localhost:5174
pnpm build         # build every package
pnpm lint          # eslint across the workspace
pnpm typecheck     # tsc --noEmit in every package
pnpm test          # unit tests (Vitest) in every package
pnpm test:e2e      # e2e tests (Playwright) in every package
```

Node 24+ and pnpm 10 (pinned via `packageManager`). To run a single package's script:

```bash
pnpm --filter @andrewshell/outliner test:e2e
```

## How the workspace fits together

- **Shared at the root**: git hooks (`.husky/`), commitlint, the single ESLint flat config,
  `tsconfig.base.json`, CI, and release-please. Each package extends
  `tsconfig.base.json` and owns its own Vite/Vitest/Playwright config.
- **Consuming the library in-repo**: depend on it as `"@andrewshell/outliner": "workspace:*"`.
  Its `exports` point at `src/`, so Vite compiles the library from source and hot-reloads on
  edits — no build step between changing the library and seeing it in an app.
  `publishConfig.exports` swaps those to `dist/` when the package is published, so npm
  consumers still get the built bundles. **This means publishing must go through
  `pnpm publish`**, not `npm publish`.
- **Releases**: release-please watches `packages/outliner` only and tags as `v<version>`.
  Apps are private and are not part of that flow.

## Desktop app

`apps/desktop` (package name `outliner-desktop`, product name **GeekityFlow**) is a Tauri v2
app that mounts `@andrewshell/outliner` full-window, with a native menu bar for file
operations. See `apps/desktop/README.md` for what it does and its design notes.

```bash
pnpm dev:desktop                                    # run it (opens a native window)
pnpm dist:desktop                                   # bundle a distributable .app / .dmg / etc.
```

Building and bundling the app requires the [Rust toolchain](https://rustup.rs) (plus the
usual Tauri OS-level prerequisites — see the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)); `pnpm dev`/`pnpm build`
at the root and `pnpm --filter outliner-desktop typecheck` only touch the TypeScript
frontend and don't need Rust installed.

### Adding a second app

The same shape works for another app in `apps/`:

- Add `"@andrewshell/outliner": "workspace:*"` to its dependencies — the explicit
  `workspace:` protocol is what guarantees the local link, since pnpm 10 defaults
  `link-workspace-packages` to `false`.
- In `tauri.conf.json`, `beforeDevCommand` / `beforeBuildCommand` should be `pnpm dev` /
  `pnpm build` (Tauri runs them with the app directory as cwd) and `frontendDist` should be
  `../dist`.
- The Rust side stays entirely inside the app's `src-tauri/`; nothing Rust belongs at the
  root. `src-tauri/target/` and `src-tauri/gen/` under `apps/*` are already gitignored, and
  ESLint already ignores `**/src-tauri/**`.

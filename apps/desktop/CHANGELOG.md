# Changelog

## [0.2.0](https://github.com/geekitycom/outliner/compare/desktop-v0.1.0...desktop-v0.2.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **outliner:** `stopListening()`, `resumeListening()`, `getFocusRoot()` and `setFocusRoot()` are removed. Suspending the outliner is now `const release = claim({ kind: 'field', el })`, and calling `release()` when done. There is deliberately no accessor for who owns the caret: branching on that is one step from moving the caret yourself, which is the class of bug this module exists to prevent.

### Features

* add app menu and keyboard shortcuts sheet to desktop app ([161072b](https://github.com/geekitycom/outliner/commit/161072b4d3dab2ea5c55b126dea24512adfcf4df))
* add Reorg menu to desktop app, mirroring Drummer ([30972a3](https://github.com/geekitycom/outliner/commit/30972a333ba1b3d5f993f41860a3222adad1720c))
* **desktop:** add a tauri-free Windows snapshot for the quit flow ([cf18820](https://github.com/geekitycom/outliner/commit/cf18820107c712b3888dc4134ac9c8ddab923499))
* **desktop:** add document state, unsaved-changes modal, and window close guard ([65a7644](https://github.com/geekitycom/outliner/commit/65a764426ab216ec6a7632b1e3fb832a631a46f7))
* **desktop:** add native macOS window tabs, rework File menu ([55fc449](https://github.com/geekitycom/outliner/commit/55fc44964ce843dab4c9715015a8cf4aa24df450))
* **desktop:** add View menu between Edit and Help ([4204561](https://github.com/geekitycom/outliner/commit/42045619cfcf7943e9cb288e6e1bb5c9bf604f05))
* **desktop:** complete the flow machine with the tab-group walk ([c027c8e](https://github.com/geekitycom/outliner/commit/c027c8e36ddd67f6dab29833d4a19065a88867ed))
* **desktop:** drive Quit's walk from the pure flow machine ([d1eea4b](https://github.com/geekitycom/outliner/commit/d1eea4be9693f0512d31c529d0bc1dc2e4670eca))
* **desktop:** generate the app icon from the SVG source ([52028ae](https://github.com/geekitycom/outliner/commit/52028ae2ad3884d7bd4703e9c0fc7603660004b6))
* **desktop:** make Cancel abort the whole flow, not just one window ([eab8cd2](https://github.com/geekitycom/outliner/commit/eab8cd21d7bb3c2512d0a127b8b1dfba5e154795))
* **desktop:** make the app multi-window, with File&gt;New/Open each opening their own window ([6e41829](https://github.com/geekitycom/outliner/commit/6e41829c28ca5492930f59db39ebdf5072dbfd70))
* **desktop:** rename the app to GeekityFlow and add the Geekity icon ([bc9f29b](https://github.com/geekitycom/outliner/commit/bc9f29b4c8c0b8968ce1b0af5a884e30f9faf6e1))
* **desktop:** restyle the unsaved-changes prompt after the macOS alert ([0a8a84d](https://github.com/geekitycom/outliner/commit/0a8a84d98827b377cfb5f67181723775039b538d))
* **desktop:** resume the quit walk from a resolved prompt ([6cb4914](https://github.com/geekitycom/outliner/commit/6cb4914743675a8c2d5f18fba2748d19f71b9a09))
* **desktop:** rework View menu into Drummer-modeled Outliner menu ([5095398](https://github.com/geekitycom/outliner/commit/50953989ee7c3285fdfa4f47d054b22cb0388bb3))
* **desktop:** show the title row ([be9071b](https://github.com/geekitycom/outliner/commit/be9071bdd5b345f6a8a1305aff56fa4bcaddf120))
* **desktop:** track mouse-driven edits in the dirty state, add docs ([bceae4d](https://github.com/geekitycom/outliner/commit/bceae4d040a0a1abca17ba3636c28f42961487bc))
* **outliner:** replace the no-arg focus API with caret ownership ([6f4942e](https://github.com/geekitycom/outliner/commit/6f4942e0c40a2d123935b3ef85268e6427a908ba))
* scaffold Tauri desktop app with Rust file I/O ([925c264](https://github.com/geekitycom/outliner/commit/925c26499d3199b25708f85deb5cba3c1e4e97bc))


### Bug Fixes

* **desktop:** apply the capability to every window, not just "main" ([abb18e2](https://github.com/geekitycom/outliner/commit/abb18e24cceb43886431849a3b04b7d8e9cf13ec))
* **desktop:** derive the shortcuts sheet's library rows from the library ([c84b57b](https://github.com/geekitycom/outliner/commit/c84b57b89703ac90481638ab95d56fce5d628387))
* **desktop:** drop the ✕ glyph from Close Tab that skewed the File menu ([0746b85](https://github.com/geekitycom/outliner/commit/0746b855d6a30ea3ce3387bab4bb62ed16cbc0b2))
* **desktop:** gate tabbing_identifier to macOS ([2e934d0](https://github.com/geekitycom/outliner/commit/2e934d04b66c68ac85cff6c4235f12b8f92a1e32))
* **desktop:** keep the native tab bar visible for single-tab windows ([5d6167f](https://github.com/geekitycom/outliner/commit/5d6167f33f0c13ca8b4c1dc52cebb6e5f5d7c6b7))
* **desktop:** only let a window that still exists veto the exit ([e23f91d](https://github.com/geekitycom/outliner/commit/e23f91d474cd657ca060f4332fd9c264e594a15a))
* **desktop:** re-enable automatic window tabbing so the tab bar shows ([358040d](https://github.com/geekitycom/outliner/commit/358040dc9102f85c6b4d278f1ab35df415d1ad7e))
* **desktop:** scope menu listeners to their window, not every window ([0da1df0](https://github.com/geekitycom/outliner/commit/0da1df0675a10f8552c0478d69f47b258080f95a))
* **desktop:** show the shortcuts the menu binds and the sheet omitted ([46742e6](https://github.com/geekitycom/outliner/commit/46742e6aeace07d3c36373383d4b4bd954873825))
* **desktop:** stop Save As overwriting a title the user set ([85dbd63](https://github.com/geekitycom/outliner/commit/85dbd630bae4030659b3e619215f119058a18daa))
* **desktop:** title an unsaved document just "Untitled" ([1575ddf](https://github.com/geekitycom/outliner/commit/1575ddf306ec026ed34ecbe920b5b648840fe915))
* grant window setTitle/destroy permissions, stop swallowing rejections ([69feca0](https://github.com/geekitycom/outliner/commit/69feca01125fcacec395d929e53183dcdb562305))
* make the title row actually clickable, and stop it filling the window ([a9cf38e](https://github.com/geekitycom/outliner/commit/a9cf38e7de79d1adfac9d74fdbe64370f6971657))
* prompt for unsaved changes on Cmd-Q instead of discarding them ([5c57a69](https://github.com/geekitycom/outliner/commit/5c57a69180290829ffd4b9161eec2a43e0d5f48a))

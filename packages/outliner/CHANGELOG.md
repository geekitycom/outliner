# Changelog

## [0.2.0](https://github.com/geekitycom/outliner/compare/v0.1.0...v0.2.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **outliner:** `stopListening()`, `resumeListening()`, `getFocusRoot()` and `setFocusRoot()` are removed. Suspending the outliner is now `const release = claim({ kind: 'field', el })`, and calling `release()` when done. There is deliberately no accessor for who owns the caret: branching on that is one step from moving the caret yourself, which is the class of bug this module exists to prevent.

### Features

* **outliner:** add an opt-in title row for the document title / hoisted headline ([90f188c](https://github.com/geekitycom/outliner/commit/90f188c27431862a4f9c6ec7d1beff6f26781325))
* **outliner:** add find/find-again to the Outliner API ([c51be0f](https://github.com/geekitycom/outliner/commit/c51be0fafd308e26c617def56779c225bfccbf6e))
* **outliner:** add hoist/de-hoist and expandToLevel to the outliner API ([0e158ef](https://github.com/geekitycom/outliner/commit/0e158efc7b31ac30aee690ff1f9d26bb599523a8))
* **outliner:** add the mi:text icon, correct the icon-source comment ([59cb55b](https://github.com/geekitycom/outliner/commit/59cb55b0b926d7ac75fd0da9f159f672dcd2e1c3))
* **outliner:** export the keystroke table ([94acb66](https://github.com/geekitycom/outliner/commit/94acb66ecef7ead6b6d125ed7a51a1bec86aae5e))
* **outliner:** replace the no-arg focus API with caret ownership ([6f4942e](https://github.com/geekitycom/outliner/commit/6f4942e0c40a2d123935b3ef85268e6427a908ba))


### Bug Fixes

* make the title row actually clickable, and stop it filling the window ([a9cf38e](https://github.com/geekitycom/outliner/commit/a9cf38e7de79d1adfac9d74fdbe64370f6971657))
* **outliner:** commit a title-row edit to what it started on ([bf7b5ba](https://github.com/geekitycom/outliner/commit/bf7b5ba86c873aed9c39d2ad7ad0f2772fe9e0ea))
* **outliner:** discard a pending title-row edit when a document loads ([063b23a](https://github.com/geekitycom/outliner/commit/063b23adcb234ac5e37edc193f63bdda67e5239f))
* **outliner:** make the title row sit flush, and de-flake its OPML guard ([75ba0c7](https://github.com/geekitycom/outliner/commit/75ba0c7374631faa5d3914a47caadce9addf50ba))
* **outliner:** stop the outline reclaiming focus from the title row ([b949fd9](https://github.com/geekitycom/outliner/commit/b949fd9fad65ca1313d6ba7582524ef344802fe7))
* **outliner:** stop the title row's edit flag from getting stuck ([51b84d2](https://github.com/geekitycom/outliner/commit/51b84d215a6eaec06965541cea48b16697e519cb))

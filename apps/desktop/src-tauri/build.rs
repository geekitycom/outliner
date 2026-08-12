use std::collections::HashSet;

/// Where the shared menu manifest lives, relative to this crate's root. The
/// same file `src/lib.rs` embeds with `include_str!("../../menu.json")` and
/// `src/menu.ts` imports on the frontend side.
const MENU_MANIFEST: &str = "../menu.json";

/// The submenu keys `build_menu` asks for by name. A manifest missing one of
/// these would make `submenu_title` panic at app startup — long after the
/// build, in front of the user — so it's checked here instead.
const REQUIRED_SUBMENUS: &[&str] = &["app", "file", "outliner", "reorg", "help"];

/// Fields an item may have. Checked here as well as by `deny_unknown_fields`
/// on the Rust structs, because this check names the offending item and field
/// in the error rather than reporting a serde path, and because the TypeScript
/// side has no equivalent guard at all: a stray field there is simply ignored.
const ITEM_FIELDS: &[&str] = &[
  "id",
  "label",
  "accelerator",
  "submenu",
  "separatorBefore",
  "description",
];

fn main() {
  validate_menu_manifest();
  tauri_build::build()
}

/// Fails the build if `menu.json` isn't a manifest both consumers can trust.
///
/// This exists because the manifest is data, and data that two languages read
/// has no compiler of its own. Rust's `include_str!` embeds whatever bytes are
/// there; a stray comma or a `"submenu": "flie"` would sail past it and turn
/// up as a panic when the app builds its menu, or — worse and more likely —
/// as a menu item that renders perfectly and does nothing when clicked. That
/// silent failure is the entire reason the manifest exists, so it would be a
/// poor trade to leave the manifest itself able to fail that way. Running the
/// check from a build script is what makes a malformed manifest a *compile*
/// error: `cargo check` runs build scripts, and a panic here fails the build
/// with the message below attached.
///
/// Deliberately written against `serde_json::Value` rather than the
/// `MenuManifest` structs in `src/lib.rs`. Those structs are one consumer's
/// view of the file; this is an independent reading of it, and an independent
/// reading is the only kind that can disagree.
fn validate_menu_manifest() {
  // Any `rerun-if-changed` at all replaces cargo's default "rerun if anything
  // in the package changed" — and this file lives *outside* the package, so
  // without this line editing the manifest would leave both the validation
  // and the `include_str!` stale until something else forced a rebuild.
  println!("cargo:rerun-if-changed={MENU_MANIFEST}");

  let source = std::fs::read_to_string(MENU_MANIFEST)
    .unwrap_or_else(|err| panic!("cannot read the menu manifest at {MENU_MANIFEST}: {err}"));
  let manifest: serde_json::Value = serde_json::from_str(&source)
    .unwrap_or_else(|err| panic!("{MENU_MANIFEST} is not valid JSON: {err}"));

  let submenus = manifest["submenus"]
    .as_array()
    .unwrap_or_else(|| panic!("{MENU_MANIFEST}: \"submenus\" must be an array"));
  let mut keys: HashSet<&str> = HashSet::new();
  for submenu in submenus {
    let key = non_empty_string(submenu, "key", "a submenu");
    let _ = non_empty_string(submenu, "title", key);
    if !keys.insert(key) {
      panic!("{MENU_MANIFEST}: two submenus share the key {key}");
    }
  }
  for required in REQUIRED_SUBMENUS {
    if !keys.contains(required) {
      panic!("{MENU_MANIFEST}: build_menu builds a {required:?} submenu, but the manifest has none");
    }
  }

  let items = manifest["items"]
    .as_array()
    .unwrap_or_else(|| panic!("{MENU_MANIFEST}: \"items\" must be an array"));
  let mut ids: HashSet<&str> = HashSet::new();
  for item in items {
    let object = item
      .as_object()
      .unwrap_or_else(|| panic!("{MENU_MANIFEST}: every entry in \"items\" must be an object"));
    let id = non_empty_string(item, "id", "an item");

    for field in object.keys() {
      if !ITEM_FIELDS.contains(&field.as_str()) {
        panic!("{MENU_MANIFEST}: item {id} has an unknown field {field:?} — a misspelled \"accelerator\" would otherwise leave the item with no key equivalent and no complaint");
      }
    }

    // The id is concatenated into the event name (`menu-{id}`) that the
    // frontend listens for, so anything that isn't a plain kebab-case
    // identifier risks a name one side can build and the other can't match.
    if !id
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
      panic!("{MENU_MANIFEST}: item id {id:?} must be lowercase kebab-case");
    }
    if !ids.insert(id) {
      panic!("{MENU_MANIFEST}: two items share the id {id} — one would shadow the other's event");
    }

    let _ = non_empty_string(item, "label", id);
    let _ = non_empty_string(item, "description", id);

    let submenu = non_empty_string(item, "submenu", id);
    if !keys.contains(submenu) {
      panic!("{MENU_MANIFEST}: item {id} belongs to submenu {submenu:?}, which the manifest does not define");
    }

    match &item["accelerator"] {
      serde_json::Value::Null => {}
      serde_json::Value::String(accelerator) if !accelerator.is_empty() => {}
      _ => panic!("{MENU_MANIFEST}: item {id}'s \"accelerator\" must be a non-empty string, or absent"),
    }
    match &item["separatorBefore"] {
      serde_json::Value::Null | serde_json::Value::Bool(_) => {}
      _ => panic!("{MENU_MANIFEST}: item {id}'s \"separatorBefore\" must be true, false, or absent"),
    }
  }
}

/// A required string field, named in the panic by the entry it belongs to so
/// the error points at a line in the manifest rather than at a JSON path.
fn non_empty_string<'a>(entry: &'a serde_json::Value, field: &str, owner: &str) -> &'a str {
  match entry[field].as_str() {
    Some(value) if !value.is_empty() => value,
    _ => panic!("{MENU_MANIFEST}: {owner} is missing a non-empty {field:?}"),
  }
}

use super::*;
use crate::permissions::GrantInput;
use crate::{
    Contribution, ContributionKind, Entry, FileDigest, PackageFile, Permission,
    package::{MAX_FILE, MAX_PACKAGE},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

fn package(version: &str) -> Package {
    let data = b"metadata only; no executable";
    Package {
        format_version: 1,
        manifest: Manifest {
            schema_version: 1,
            id: "dev.example".into(),
            name: "Metadata fixture".into(),
            icon: None,
            version: version.into(),
            author: "Local developer".into(),
            description: "No executable entry".into(),
            api_version: "^5.0".into(),
            entry: Entry {
                backend: None,
                ui: None,
            },
            permissions: vec![],
            preapproved_commands: vec![],
            assist_commands: vec![],
            contributions: vec![],
            platforms: vec![std::env::consts::OS.into()],
            publisher: None,
            files: vec![FileDigest {
                path: "readme.txt".into(),
                size: data.len() as u64,
                sha256: digest(data),
            }],
        },
        files: vec![PackageFile {
            path: "readme.txt".into(),
            content: STANDARD.encode(data),
        }],
    }
}
fn save(dir: &Path, package: &Package) -> PathBuf {
    let path = dir.join("fixture.sdplugin");
    fs::write(&path, serde_json::to_vec(package).unwrap()).unwrap();
    path
}
fn input(path: &Path, old: Option<&str>) -> InstallInput {
    InstallInput {
        path: path.to_owned(),
        development_confirmed: true,
        expected_version: old.map(str::to_owned),
        expected_digest: None,
    }
}

#[test]
fn invalid_records_are_reported_without_hiding_healthy_plugins_or_blocking_new_installs() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let installed = repo
        .install(input(&save(dir.path(), &package("1.0.0")), None))
        .unwrap();
    let record = repo
        .folder(&installed.manifest.id)
        .unwrap()
        .join("record.json");
    let mut raw: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    raw["current"]["manifest"]["permissions"] =
        serde_json::json!(["removed-permission-sensitive-fixture"]);
    let bytes = serde_json::to_vec(&raw).unwrap();
    fs::write(&record, &bytes).unwrap();
    let inventory = repo.inventory().unwrap();
    assert!(inventory.installed.is_empty());
    assert_eq!(inventory.problems.len(), 1);
    assert_eq!(inventory.problems[0].id, "dev.example");
    assert_eq!(inventory.problems[0].record_digest, Some(digest(&bytes)));
    assert!(!inventory.problems[0].message.contains("sensitive-fixture"));
    assert!(repo.detail("dev.example").is_err());
    let mut healthy = package("1.0.0");
    healthy.manifest.id = "dev.healthy".into();
    repo.install(input(&save(dir.path(), &healthy), None))
        .unwrap();
    let inventory = repo.inventory().unwrap();
    assert_eq!(inventory.installed[0].manifest.id, "dev.healthy");
    assert_eq!(inventory.problems.len(), 1);
    assert_eq!(fs::read(&record).unwrap(), bytes);
}
#[test]
fn explicit_reinstall_freezes_and_backs_up_bad_record_without_migrating_or_deleting_data() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let installed = repo
        .install(input(&save(dir.path(), &package("1.0.0")), None))
        .unwrap();
    repo.settings_write("dev.example", &serde_json::json!({"preserve":"settings"}))
        .unwrap();
    let original_payload = repo
        .payload_folder(PluginSource::User, "dev.example")
        .unwrap()
        .join("versions")
        .join(&installed.revision)
        .join("readme.txt");
    let record = repo.folder("dev.example").unwrap().join("record.json");
    fs::write(&record, b"{ invalid record }").unwrap();
    let original = fs::read(&record).unwrap();
    let token = digest(&original);
    let bytes = serde_json::to_vec(&package("2.0.0")).unwrap();
    assert!(
        repo.reinstall_bundled(&bytes, "dev.example", &token, false)
            .is_err()
    );
    assert!(
        repo.reinstall_bundled(&bytes, "dev.example", "stale", true)
            .is_err()
    );
    assert_eq!(fs::read(&record).unwrap(), original);
    let repaired = repo
        .reinstall_bundled(&bytes, "dev.example", &token, true)
        .unwrap();
    assert!(!repaired.enabled);
    assert_eq!(repaired.source, PluginSource::System);
    assert_eq!(repaired.manifest.api_version, "^5.0");
    assert_eq!(repaired.manifest.version, "2.0.0");
    assert!(repo.inventory().unwrap().problems.is_empty());
    assert!(original_payload.is_file());
    assert_eq!(
        repo.settings_read("dev.example").unwrap()["preserve"],
        "settings"
    );
    let backups = fs::read_dir(record.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("record-backup-")
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read(&backups[0]).unwrap(), original);
    assert!(
        repo.reinstall_bundled(
            &bytes,
            "dev.example",
            &digest(&fs::read(&record).unwrap()),
            true
        )
        .is_err()
    );
}
#[test]
fn failed_reinstall_commit_preserves_the_exact_record_and_original_payload() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let installed = repo
        .install(input(&save(dir.path(), &package("1.0.0")), None))
        .unwrap();
    let record = repo.folder("dev.example").unwrap().join("record.json");
    let raw = b"{ damaged record }";
    fs::write(&record, raw).unwrap();
    let candidate =
        Package::read(&save(dir.path(), &package("2.0.0")), std::env::consts::OS).unwrap();
    assert!(
        repo.commit_package(candidate, PluginSource::System, None, true, Some(raw))
            .is_err()
    );
    assert_eq!(fs::read(&record).unwrap(), raw);
    assert!(
        repo.payload_folder(PluginSource::User, "dev.example")
            .unwrap()
            .join("versions")
            .join(installed.revision)
            .join("readme.txt")
            .is_file()
    );
}

#[test]
fn independent_ui_assets_require_current_grants_declared_entries_and_matching_digests() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let mut p = package("1.0.0");
    p.manifest.api_version = "^5.0.0".into();
    p.manifest.entry.backend = Some("backend.wasm".into());
    p.manifest.entry.ui = Some("ui.json".into());
    p.manifest.permissions = vec![Permission::UiContribute];
    p.manifest.contributions = vec![Contribution {
        id: "custom".into(),
        label: "Custom".into(),
        kind: ContributionKind::Workspace,
        routes: vec![],
    }];
    let ui = include_bytes!("../../../../tests/fixtures/plugins/custom-ui/ui.json");
    for (path, bytes) in [
        ("ui.json", ui.as_slice()),
        ("backend.wasm", b"\0asm\x01\0\0\0".as_slice()),
        (
            "frontend.js",
            b"document.body.textContent='owned package'".as_slice(),
        ),
        ("frontend.css", b"body{color:inherit}".as_slice()),
    ] {
        p.manifest.files.push(FileDigest {
            path: path.into(),
            size: bytes.len() as u64,
            sha256: digest(bytes),
        });
        p.files.push(PackageFile {
            path: path.into(),
            content: STANDARD.encode(bytes),
        });
    }
    let path = save(dir.path(), &p);
    let installed = repo.install(input(&path, None)).unwrap();
    assert!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.js")
            .is_err()
    );
    repo.set_enabled("dev.example", true).unwrap();
    assert!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.js")
            .is_err()
    );
    repo.set_grant(
        "dev.example",
        GrantInput {
            expected_revision: installed.revision.clone(),
            permissions: vec![Permission::UiContribute],
            operations: vec!["ui.contribute".into()],
            read_roots: vec![],
            write_roots: vec![],
            confirmed: true,
        },
    )
    .unwrap();
    assert_eq!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.js")
            .unwrap(),
        b"document.body.textContent='owned package'"
    );
    assert!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.css")
            .is_ok()
    );
    for invalid in ["readme.txt", "backend.wasm", "ui.json", "../frontend.js"] {
        assert!(
            repo.frontend_asset("dev.example", &installed.revision, invalid)
                .is_err()
        );
    }
    assert!(
        repo.frontend_asset("dev.example", "stale", "frontend.js")
            .is_err()
    );
    let asset = repo
        .payload_folder(installed.source, "dev.example")
        .unwrap()
        .join("versions")
        .join(&installed.revision)
        .join("frontend.js");
    fs::write(&asset, b"tampered").unwrap();
    assert!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.js")
            .is_err()
    );
    repo.revoke_grant("dev.example").unwrap();
    assert!(
        repo.frontend_asset("dev.example", &installed.revision, "frontend.css")
            .is_err()
    );
    let mut missing = p.clone();
    missing
        .manifest
        .files
        .retain(|file| file.path != "frontend.js");
    missing.files.retain(|file| file.path != "frontend.js");
    assert!(
        Package::validate_bytes(&serde_json::to_vec(&missing).unwrap(), std::env::consts::OS)
            .is_err()
    );
}
#[test]
fn optional_plugin_icon_survives_preview_install_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let mut p = package("1.0.0");
    let without_icon = serde_json::to_vec(&p).unwrap();
    assert!(
        serde_json::to_value(&p).unwrap()["manifest"]
            .get("icon")
            .is_none()
    );
    assert!(Package::validate_bytes(&without_icon, std::env::consts::OS).is_ok());
    p.manifest.icon = Some("rocket".into());
    p.manifest.api_version = "^5.0.0".into();
    let path = save(dir.path(), &p);
    assert_eq!(
        repo.preview_info(&path).unwrap().manifest.icon.as_deref(),
        Some("rocket")
    );
    let installed = repo.install(input(&path, None)).unwrap();
    assert_eq!(installed.manifest.icon.as_deref(), Some("rocket"));
    let reopened = Repository::open(root).unwrap();
    let loaded = reopened.detail("dev.example").unwrap();
    assert_eq!(loaded.manifest.icon.as_deref(), Some("rocket"));
    assert_eq!(loaded.package_digest, installed.package_digest);
    assert_eq!(loaded.revision, installed.revision);
    assert!(!loaded.enabled);
    assert!(reopened.grant("dev.example").unwrap().is_none());
}

#[test]
fn plugin_icon_rejects_paths_urls_markup_and_invalid_names_but_allows_future_icon_names() {
    let mut p = package("1.0.0");
    for icon in [
        "",
        "Bot",
        "1bot",
        "../icon",
        "icons/bot.svg",
        "https://example.com/a",
        "<svg>",
        "-bot",
        "bot-",
        "bot--name",
        "图标",
    ] {
        p.manifest.icon = Some(icon.into());
        assert!(p.manifest.validate(std::env::consts::OS).is_err(), "{icon}");
    }
    p.manifest.icon = Some("a".repeat(65));
    assert!(p.manifest.validate(std::env::consts::OS).is_err());
    p.manifest.icon = Some("future-icon-2".into());
    assert!(p.manifest.validate(std::env::consts::OS).is_ok());
    let mut value = serde_json::to_value(&p).unwrap();
    value["manifest"]["icon"] = serde_json::json!({"url": "https://example.com/a"});
    assert!(
        Package::validate_bytes(&serde_json::to_vec(&value).unwrap(), std::env::consts::OS)
            .is_err()
    );
}

#[test]
fn preview_digest_and_ui_grant_are_enforced_and_unknown_fields_rejected() {
    use crate::permissions::GrantInput;
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let mut p = package("1.0.0");
    let ui = br#"{"uiVersion":4,"title":{"zh-CN":"Host","en-US":"Host"},"frontend":{"script":"frontend.js","style":"frontend.css"},"pages":[{"id":"host","title":"Host","surface":{"kind":"frontend"},"initialAction":null,"fields":[],"actions":[{"id":"read","label":"Read","discardDirty":false,"enabledWhen":null}],"log":null}]}"#;
    p.manifest.entry.ui = Some("ui.json".into());
    p.manifest.entry.backend = Some("backend.wasm".into());
    p.manifest.permissions = vec![Permission::UiContribute];
    p.manifest.contributions = vec![Contribution {
        id: "host".into(),
        label: "Host".into(),
        kind: ContributionKind::Workspace,
        routes: vec![],
    }];
    for (path, bytes) in [
        ("ui.json", ui.as_slice()),
        (
            "frontend.js",
            b"document.body.textContent='Host'".as_slice(),
        ),
        ("frontend.css", b"body{color:inherit}".as_slice()),
        ("backend.wasm", b"\0asm\x01\0\0\0".as_slice()),
    ] {
        p.manifest.files.push(FileDigest {
            path: path.into(),
            size: bytes.len() as u64,
            sha256: digest(bytes),
        });
        p.files.push(PackageFile {
            path: path.into(),
            content: STANDARD.encode(bytes),
        });
    }
    let path = save(dir.path(), &p);
    let preview = repo.preview_info(&path).unwrap();
    assert!(
        repo.install(InstallInput {
            expected_digest: Some("bad".into()),
            ..input(&path, None)
        })
        .is_err()
    );
    let installed = repo
        .install(InstallInput {
            expected_digest: Some(preview.package_digest),
            ..input(&path, None)
        })
        .unwrap();
    repo.set_enabled("dev.example", true).unwrap();
    assert!(repo.ui("dev.example", &installed.revision).is_err());
    repo.set_grant(
        "dev.example",
        GrantInput {
            expected_revision: installed.revision.clone(),
            permissions: vec![Permission::UiContribute],
            operations: vec!["ui.contribute".into()],
            read_roots: vec![],
            write_roots: vec![],
            confirmed: true,
        },
    )
    .unwrap();
    assert_eq!(
        repo.ui("dev.example", &installed.revision).unwrap().pages[0].id,
        "host"
    );
    assert!(repo.ui("dev.example", "stale").is_err());
    repo.revoke_grant("dev.example").unwrap();
    assert!(repo.ui("dev.example", &installed.revision).is_err());
    let original: Value = serde_json::from_slice(ui).unwrap();
    let mut unknown = original.clone();
    unknown["script"] = serde_json::json!("credential_read");
    let mut invalid_field = original.clone();
    invalid_field["pages"][0]["fields"] =
        serde_json::json!([{"id":"__proto__","label":"Bad","kind":"text","default":""}]);
    for value in [unknown, invalid_field] {
        let bytes = serde_json::to_vec(&value).unwrap();
        p.files[1].content = STANDARD.encode(&bytes);
        p.manifest.files[1].size = bytes.len() as u64;
        p.manifest.files[1].sha256 = digest(&bytes);
        assert!(validate(&p).is_err());
    }
}
fn validate(package: &Package) -> Result<ValidatedPackage, Error> {
    Package::validate_bytes(&serde_json::to_vec(package).unwrap(), std::env::consts::OS)
}
use crate::ValidatedPackage;

#[test]
fn install_restart_enable_upgrade_uninstall_preserves_data_and_removes_all_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    assert!(
        repo.install(InstallInput {
            development_confirmed: false,
            ..input(&path, None)
        })
        .is_err()
    );
    let installed = repo.install(input(&path, None)).unwrap();
    assert!(!installed.enabled);
    assert_eq!(installed.trust, Trust::LocalDevelopmentUnverified);
    let data = repo.data_directory("dev.example").unwrap();
    fs::write(data.join("settings.json"), b"user data").unwrap();
    repo.set_enabled("dev.example", true).unwrap();
    let restarted = Repository::open(root.clone()).unwrap();
    assert!(restarted.list().unwrap()[0].enabled);
    let path = save(dir.path(), &package("1.1.0"));
    let upgraded = restarted.install(input(&path, Some("1.0.0"))).unwrap();
    assert_eq!(upgraded.previous_version.as_deref(), Some("1.0.0"));
    assert!(
        !upgraded.enabled,
        "upgrade requires reactivation and future reauthorization"
    );
    assert!(
        root.join("upload/dev.example/versions")
            .join(installed.revision)
            .exists()
    );
    assert!(
        restarted
            .uninstall(UninstallInput {
                id: "dev.example".into(),
                clear_data: false,
                confirmed: false
            })
            .is_err()
    );
    restarted
        .uninstall(UninstallInput {
            id: "dev.example".into(),
            clear_data: false,
            confirmed: true,
        })
        .unwrap();
    assert!(restarted.list().unwrap().is_empty());
    assert!(!root.join("packages/dev.example").exists());
    assert_eq!(fs::read(data.join("settings.json")).unwrap(), b"user data");
    restarted.install(input(&path, None)).unwrap();
    restarted
        .uninstall(UninstallInput {
            id: "dev.example".into(),
            clear_data: true,
            confirmed: true,
        })
        .unwrap();
    assert!(!data.exists());
}

#[test]
fn duplicate_id_downgrade_and_stale_upgrade_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    repo.install(input(&path, None)).unwrap();
    assert!(repo.install(input(&path, None)).is_err());
    assert!(repo.install(input(&path, Some("1.0.0"))).is_err());
    let path = save(dir.path(), &package("0.9.0"));
    assert!(repo.install(input(&path, Some("1.0.0"))).is_err());
    let path = save(dir.path(), &package("2.0.0"));
    assert!(repo.install(input(&path, Some("0.9.0"))).is_err());
    assert_eq!(
        repo.detail("dev.example").unwrap().manifest.version,
        "1.0.0"
    );
}

#[test]
fn upgrade_failure_rolls_back_pointer_and_cleans_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    let old = repo.install(input(&path, None)).unwrap();
    repo.set_enabled("dev.example", true).unwrap();
    let path = save(dir.path(), &package("2.0.0"));
    assert!(
        repo.install_inner(input(&path, Some("1.0.0")), true)
            .is_err()
    );
    let after = repo.detail("dev.example").unwrap();
    assert!(after.enabled);
    assert_eq!(after.revision, old.revision);
    assert_eq!(
        repo.read_file(&after, "readme.txt").unwrap(),
        b"metadata only; no executable"
    );
    assert_eq!(
        fs::read_dir(
            repo.payload_folder(PluginSource::User, "dev.example")
                .unwrap()
                .join("versions")
        )
        .unwrap()
        .count(),
        1
    );
}

#[test]
fn rejects_paths_aliases_duplicate_files_and_file_directory_conflicts() {
    for path in [
        "../escape",
        "/absolute",
        "C:/file",
        "a\\b",
        "a/../b",
        "./a",
        "a//b",
        "a:stream",
        "NUL.txt",
        "a.",
        "COM1",
        "",
    ] {
        let mut p = package("1.0.0");
        p.files[0].path = path.into();
        p.manifest.files[0].path = path.into();
        assert!(validate(&p).is_err(), "accepted {path}");
    }
    for path in ["readme.txt", "README.TXT", "readme.txt/child"] {
        let mut p = package("1.0.0");
        let mut file = p.files[0].clone();
        file.path = path.into();
        p.files.push(file);
        let mut digest = p.manifest.files[0].clone();
        digest.path = path.into();
        p.manifest.files.push(digest);
        assert!(validate(&p).is_err());
    }
    for id in [
        "../escape",
        "dev..example",
        "Dev.example",
        "dev/example",
        "",
        "dev.con",
    ] {
        // CON is rejected when it is a path component; dev.con as an ID is safe on disk.
        if id == "dev.con" {
            continue;
        }
        let mut p = package("1.0.0");
        p.manifest.id = id.into();
        assert!(validate(&p).is_err());
    }
}

#[test]
fn rejects_incompatible_versions_permissions_unknown_fields_links_and_corruption() {
    for api in ["^1.0", "^2.0", "^3.0", "^99.0", "not a range"] {
        let mut p = package("1.0.0");
        p.manifest.api_version = api.into();
        assert!(validate(&p).is_err());
    }
    assert!(validate(&package("not-semver")).is_err());
    let mut p = package("1.0.0");
    p.manifest.platforms = vec!["unsupported".into()];
    assert!(validate(&p).is_err());
    let mut p = package("1.0.0");
    p.manifest.permissions = vec![Permission::HostsRead, Permission::HostsRead];
    assert!(validate(&p).is_err());
    let mut p = package("1.0.0");
    p.manifest.contributions = vec![Contribution {
        id: "view".into(),
        label: "View".into(),
        kind: ContributionKind::Workspace,
        routes: vec![],
    }];
    assert!(validate(&p).is_err());
    let mut p = package("1.0.0");
    p.files[0].content = STANDARD.encode(b"tampered");
    assert!(validate(&p).is_err());
    let mut p = package("1.0.0");
    p.files[0].content = "invalid base64".into();
    assert!(validate(&p).is_err());
    let mut json = serde_json::to_value(package("1.0.0")).unwrap();
    json["files"][0]["symlink"] = "../escape".into();
    assert!(
        Package::validate_bytes(&serde_json::to_vec(&json).unwrap(), std::env::consts::OS).is_err()
    );
    assert!(
        Package::validate_bytes(b"PK\x03\x04 compressed archive", std::env::consts::OS).is_err()
    );
    assert!(Package::validate_bytes(b"{broken", std::env::consts::OS).is_err());
    let text = String::from_utf8(serde_json::to_vec(&package("1.0.0")).unwrap())
        .unwrap()
        .replacen(
            "\"formatVersion\":1",
            "\"formatVersion\":1,\"formatVersion\":1",
            1,
        );
    assert!(Package::validate_bytes(text.as_bytes(), std::env::consts::OS).is_err());
}

#[test]
fn contribution_pages_and_frontend_contracts_are_validated_without_business_tool_types() {
    let original: Value = serde_json::from_slice(include_bytes!(
        "../../../../plugins/system/packages/assistant.sdplugin"
    ))
    .unwrap();
    let validate_json =
        |p: &Value| Package::validate_bytes(&serde_json::to_vec(p).unwrap(), std::env::consts::OS);
    assert!(validate_json(&original).is_ok());
    let mut p = original.clone();
    p["manifest"]["contributions"][0]["tool"] = serde_json::json!("network");
    assert!(
        validate_json(&p).is_err(),
        "business tool fields are not part of the platform manifest"
    );
    let mut p = original.clone();
    p["manifest"]["contributions"][0]["routes"] = serde_json::json!(["duplicate", "duplicate"]);
    assert!(
        validate_json(&p).is_err(),
        "routes must be unique identifiers"
    );
    let mut p = original.clone();
    p["manifest"]["contributions"][0]["kind"] = serde_json::json!("navigation");
    assert!(
        validate_json(&p).is_ok(),
        "generic frontend pages may use any supported contribution point"
    );
    let mut p = original.clone();
    p["manifest"]["entry"]["backend"] = Value::Null;
    assert!(
        validate_json(&p).is_err(),
        "standard tool pages cannot bypass the WASM backend"
    );
    let mut p = original;
    let file = p["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|f| f["path"] == "ui.json")
        .unwrap();
    let mut ui: Value =
        serde_json::from_slice(&STANDARD.decode(file["content"].as_str().unwrap()).unwrap())
            .unwrap();
    ui["uiVersion"] = serde_json::json!(2);
    let bytes = serde_json::to_vec(&ui).unwrap();
    file["content"] = serde_json::json!(STANDARD.encode(&bytes));
    let item = p["manifest"]["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|f| f["path"] == "ui.json")
        .unwrap();
    item["size"] = serde_json::json!(bytes.len());
    item["sha256"] = serde_json::json!(digest(&bytes));
    assert!(
        validate_json(&p).is_err(),
        "valid hashes do not allow a tool surface in UI v2"
    );
}

#[test]
fn rejects_oversized_package_and_decoded_file() {
    assert!(
        Package::validate_bytes(&vec![b' '; MAX_PACKAGE as usize + 1], std::env::consts::OS)
            .is_err()
    );
    let mut p = package("1.0.0");
    p.files[0].content = STANDARD.encode(vec![0; MAX_FILE + 1]);
    assert!(validate(&p).is_err());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("huge.sdplugin");
    fs::File::create(&path)
        .unwrap()
        .set_len(MAX_PACKAGE + 1)
        .unwrap();
    assert!(Package::read(&path, std::env::consts::OS).is_err());
}

#[test]
fn tampered_installed_entry_cannot_be_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    let installed = repo.install(input(&path, None)).unwrap();
    fs::write(
        repo.payload_folder(PluginSource::User, "dev.example")
            .unwrap()
            .join("versions")
            .join(installed.revision)
            .join("readme.txt"),
        b"tampered",
    )
    .unwrap();
    assert!(repo.set_enabled("dev.example", true).is_err());
    assert!(!repo.detail("dev.example").unwrap().enabled);
}

#[test]
fn grants_persist_but_upgrade_new_permissions_revoke_and_uninstall_never_reuses_them() {
    use crate::permissions::GrantInput;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let mut p = package("1.0.0");
    p.manifest.permissions = vec![Permission::HostsRead];
    let path = save(dir.path(), &p);
    let installed = repo.install(input(&path, None)).unwrap();
    let grant = GrantInput {
        expected_revision: installed.revision,
        permissions: vec![Permission::HostsRead],
        operations: vec!["hosts.read".into()],
        read_roots: vec![],
        write_roots: vec![],
        confirmed: true,
    };
    repo.set_grant("dev.example", grant).unwrap();
    let restarted = Repository::open(root).unwrap();
    assert!(restarted.grant("dev.example").unwrap().is_some());
    p.manifest.version = "2.0.0".into();
    p.manifest.permissions.push(Permission::SftpRead);
    let path = save(dir.path(), &p);
    restarted.install(input(&path, Some("1.0.0"))).unwrap();
    assert!(restarted.grant("dev.example").unwrap().is_none());
    restarted
        .uninstall(UninstallInput {
            id: "dev.example".into(),
            clear_data: false,
            confirmed: true,
        })
        .unwrap();
    restarted.install(input(&path, None)).unwrap();
    assert!(restarted.grant("dev.example").unwrap().is_none());
}

#[cfg(windows)]
#[test]
fn windows_junction_escape_is_rejected_and_cleanup_preserves_target() {
    use std::os::windows::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    let installed = repo.install(input(&path, None)).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), b"not plugin data").unwrap();
    let link = repo
        .payload_folder(PluginSource::User, "dev.example")
        .unwrap()
        .join("versions")
        .join(installed.revision)
        .join("escape");
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:PLUGIN_TEST_LINK -Target $env:PLUGIN_TEST_TARGET | Out-Null"])
        .env("PLUGIN_TEST_LINK", &link).env("PLUGIN_TEST_TARGET", &outside)
        .creation_flags(0x08000000).status().unwrap();
    assert!(status.success(), "create owned test junction");
    assert!(Repository::open(link.clone()).is_err());
    assert!(
        repo.uninstall(UninstallInput {
            id: "dev.example".into(),
            clear_data: true,
            confirmed: true
        })
        .is_err()
    );
    assert_eq!(
        fs::read(outside.join("keep.txt")).unwrap(),
        b"not plugin data"
    );
    fs::remove_dir(link).unwrap();
    repo.uninstall(UninstallInput {
        id: "dev.example".into(),
        clear_data: true,
        confirmed: true,
    })
    .unwrap();
}

#[cfg(windows)]
#[test]
fn real_atomic_commit_error_keeps_old_generation() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    let original = repo.install(input(&path, None)).unwrap();
    let record = repo.folder("dev.example").unwrap().join("record.json");
    let permissions = fs::metadata(&record).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&record, readonly).unwrap();
    let path = save(dir.path(), &package("2.0.0"));
    let result = repo.install(input(&path, Some("1.0.0")));
    fs::set_permissions(&record, permissions).unwrap();
    assert!(result.is_err(), "read-only record must fail at real commit");
    let after = repo.detail("dev.example").unwrap();
    assert_eq!(after.revision, original.revision);
    assert_eq!(
        repo.read_file(&after, "readme.txt").unwrap(),
        b"metadata only; no executable"
    );
    assert_eq!(
        fs::read_dir(
            repo.payload_folder(PluginSource::User, "dev.example")
                .unwrap()
                .join("versions")
        )
        .unwrap()
        .count(),
        1
    );
}

#[test]
fn source_change_stores_uploaded_upgrade_in_upload_and_keeps_system_backup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let original = repo
        .install_bundled(
            &serde_json::to_vec(&package("1.0.0")).unwrap(),
            "dev.example",
        )
        .unwrap();
    assert!(
        root.join("system/dev.example/versions")
            .join(&original.revision)
            .exists()
    );
    let path = save(dir.path(), &package("2.0.0"));
    let upgraded = repo.install(input(&path, Some("1.0.0"))).unwrap();
    assert_eq!(upgraded.source, PluginSource::User);
    assert!(
        root.join("upload/dev.example/versions")
            .join(&upgraded.revision)
            .exists()
    );
    assert!(
        root.join("system/dev.example/versions")
            .join(&original.revision)
            .exists()
    );
    assert!(repo.read_file(&original, "readme.txt").is_ok());
    repo.uninstall(UninstallInput {
        id: "dev.example".into(),
        clear_data: false,
        confirmed: true,
    })
    .unwrap();
    assert!(!root.join("upload/dev.example").exists());
    assert!(!root.join("system/dev.example").exists());
}

#[test]
fn unsupported_records_fail_without_migrating_or_deleting_user_data() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    repo.install(input(&save(dir.path(), &package("1.0.0")), None))
        .unwrap();
    let record_path = root.join("packages/dev.example/record.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    record["current"]["manifest"]["apiVersion"] = serde_json::json!("^1.0.0");
    let original = serde_json::to_vec(&record).unwrap();
    fs::write(&record_path, &original).unwrap();
    let data = root.join("data/dev.example");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("settings.json"), b"preserve user data").unwrap();
    let reopened = Repository::open(root.clone()).unwrap();
    assert!(reopened.list().is_err());
    assert_eq!(fs::read(&record_path).unwrap(), original);
    assert_eq!(
        fs::read(data.join("settings.json")).unwrap(),
        b"preserve user data"
    );
    assert!(!root.join("retired").exists());
}

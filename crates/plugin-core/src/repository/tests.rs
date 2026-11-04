use super::*;
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
            version: version.into(),
            author: "Local developer".into(),
            description: "No executable entry".into(),
            api_version: "^1.0".into(),
            entry: Entry {
                backend: None,
                ui: None,
            },
            permissions: vec![],
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
fn preview_digest_and_ui_grant_are_enforced_and_scripts_rejected() {
    use crate::permissions::GrantInput;
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::open(dir.path().join("plugins")).unwrap();
    let mut p = package("1.0.0");
    let ui=br#"{"uiVersion":1,"title":{"zh-CN":"Host","en-US":"Host"},"pages":[{"id":"host","title":"Host","initialAction":"read","fields":[],"actions":[],"log":null}]}"#;
    p.manifest.entry.ui = Some("ui.json".into());
    p.manifest.permissions = vec![Permission::UiContribute];
    p.manifest.contributions = vec![Contribution {
        id: "host".into(),
        label: "Host".into(),
        kind: ContributionKind::Workspace,
        tool: None,
    }];
    p.manifest.files.push(FileDigest {
        path: "ui.json".into(),
        size: ui.len() as u64,
        sha256: digest(ui),
    });
    p.files.push(PackageFile {
        path: "ui.json".into(),
        content: STANDARD.encode(ui),
    });
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
            host_ids: vec![],
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
    for value in [
        serde_json::json!({"uiVersion":1,"title":"Bad","pages":[],"script":"credential_read"}),
        serde_json::json!({"uiVersion":1,"title":"Bad","pages":[{"id":"host","title":"Host","fields":[{"id":"__proto__","label":"Bad","kind":"text","default":""}],"actions":[]}]}),
    ] {
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
    for api in ["^2.0", "not a range"] {
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
        tool: None,
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
fn tool_packages_require_matching_contributions_and_standard_views() {
    let original: Value = serde_json::from_slice(include_bytes!(
        "../../../../plugins/system/packages/network.sdplugin"
    ))
    .unwrap();
    let validate_json =
        |p: &Value| Package::validate_bytes(&serde_json::to_vec(p).unwrap(), std::env::consts::OS);
    assert!(validate_json(&original).is_ok());
    let mut p = original.clone();
    p["manifest"]["contributions"][0]["tool"] = serde_json::json!("batch");
    assert!(
        validate_json(&p).is_err(),
        "manifest and UI tool types must match"
    );
    let mut p = original.clone();
    p["manifest"]["contributions"][0]
        .as_object_mut()
        .unwrap()
        .remove("tool");
    assert!(validate_json(&p).is_err(), "tool type is required");
    let mut p = original.clone();
    p["manifest"]["contributions"][0]["kind"] = serde_json::json!("navigation");
    assert!(
        validate_json(&p).is_err(),
        "other contributions cannot impersonate a tool"
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
        host_ids: vec!["12345678-1234-4234-8234-123456789012".into()],
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
fn legacy_payload_layout_migrates_without_changing_revision_grants_or_settings() {
    use crate::permissions::GrantInput;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let mut package = package("1.0.0");
    package.manifest.permissions = vec![Permission::SettingsRead, Permission::SettingsWrite];
    let path = save(dir.path(), &package);
    let plugin = repo.install(input(&path, None)).unwrap();
    repo.set_enabled("dev.example", true).unwrap();
    repo.set_grant(
        "dev.example",
        GrantInput {
            expected_revision: plugin.revision.clone(),
            permissions: vec![Permission::SettingsRead],
            host_ids: vec![],
            operations: vec!["settings.read".into()],
            read_roots: vec![],
            write_roots: vec![],
            confirmed: true,
        },
    )
    .unwrap();
    repo.settings_write("dev.example", &serde_json::json!({"theme":"dark"}))
        .unwrap();
    let record = fs::read(repo.folder("dev.example").unwrap().join("record.json")).unwrap();
    let authorization = fs::read(root.join("authorizations/dev.example.json")).unwrap();
    let legacy = repo.folder("dev.example").unwrap().join("versions");
    fs::rename(
        repo.payload_folder(PluginSource::User, "dev.example")
            .unwrap()
            .join("versions"),
        &legacy,
    )
    .unwrap();
    let migrated = Repository::open(root.clone()).unwrap();
    let current = migrated.detail("dev.example").unwrap();
    assert_eq!(current.revision, plugin.revision);
    assert!(current.enabled);
    assert_eq!(
        fs::read(migrated.folder("dev.example").unwrap().join("record.json")).unwrap(),
        record
    );
    assert_eq!(
        fs::read(root.join("authorizations/dev.example.json")).unwrap(),
        authorization
    );
    assert!(migrated.grant("dev.example").unwrap().is_some());
    assert_eq!(
        migrated.settings_read("dev.example").unwrap()["theme"],
        "dark"
    );
    assert!(
        root.join("upload/dev.example/versions")
            .join(&current.revision)
            .exists()
    );
    assert_eq!(
        migrated.read_file(&current, "readme.txt").unwrap(),
        b"metadata only; no executable"
    );
    Repository::open(root).unwrap();
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
fn migration_refuses_a_conflicting_payload_without_overwriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    let path = save(dir.path(), &package("1.0.0"));
    let plugin = repo.install(input(&path, None)).unwrap();
    let legacy = repo
        .folder("dev.example")
        .unwrap()
        .join("versions")
        .join(&plugin.revision);
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("keep.txt"), b"old bytes").unwrap();
    assert!(Repository::open(root).is_err());
    assert_eq!(fs::read(legacy.join("keep.txt")).unwrap(), b"old bytes");
    assert!(repo.read_file(&plugin, "readme.txt").is_ok());
}

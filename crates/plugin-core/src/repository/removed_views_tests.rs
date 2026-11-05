use super::*;
use serde_json::json;
use serverdeck_core::IpcError;

fn ui_package(version: &str) -> Package {
    let mut p = package(version);
    p.manifest.api_version = "^3.0.0".into();
    p.manifest.entry.ui = Some("ui.json".into());
    p.manifest.entry.backend = Some("backend.wasm".into());
    p.manifest.permissions = vec![Permission::UiContribute, Permission::SystemRead];
    let ui = json!({"uiVersion":3,"title":"Legacy Docker","pages":[{"id":"server","title":"Docker","initialAction":null,"fields":[],"actions":[{"id":"bridge","label":"bridge","discardDirty":false,"enabledWhen":null}],"log":null,"surface":{"kind":"operations","sections":["containers","images"]}}]});
    for (name, bytes) in [
        ("ui.json", serde_json::to_vec(&ui).unwrap()),
        ("backend.wasm", b"\0asm\x01\0\0\0".to_vec()),
    ] {
        p.manifest.files.push(FileDigest {
            path: name.into(),
            size: bytes.len() as u64,
            sha256: digest(&bytes),
        });
        p.files.push(PackageFile {
            path: name.into(),
            content: STANDARD.encode(bytes),
        });
    }
    p
}
fn replace_surface(root: &Path, key: &str, surface: Value) -> (Vec<u8>, PathBuf) {
    let record_path = root.join("packages/dev.example/record.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    let revision = record[key]["revision"].as_str().unwrap().to_owned();
    let folder = root.join("upload/dev.example/versions").join(revision);
    let path = folder.join("ui.json");
    let mut ui: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    ui["pages"][0]["surface"] = surface;
    let bytes = serde_json::to_vec(&ui).unwrap();
    fs::write(path, &bytes).unwrap();
    let file = record[key]["manifest"]["files"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|f| f["path"] == "ui.json")
        .unwrap();
    file["size"] = json!(bytes.len());
    file["sha256"] = json!(digest(&bytes));
    let original = serde_json::to_vec(&record).unwrap();
    fs::write(record_path, &original).unwrap();
    (original, folder)
}
#[test]
fn service_identities_retire_all_sources_and_preserve_data_authorizations_and_bytes() {
    for id in [
        "cn.hiboot.plugins.services",
        "io.serverdeck.plugins.services",
    ] {
        for source in ["system", "user"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("plugins");
            let repo = Repository::open(root.clone()).unwrap();
            repo.install(input(&save(dir.path(), &package("1.0.0")), None))
                .unwrap();
            let mut record: Value = serde_json::from_slice(
                &fs::read(root.join("packages/dev.example/record.json")).unwrap(),
            )
            .unwrap();
            record["current"]["manifest"]["id"] = json!(id);
            record["current"]["source"] = json!(source);
            record["current"]["manifest"]["permissions"] = json!(["network.run"]);
            let folder = root.join("packages").join(id);
            fs::create_dir(&folder).unwrap();
            let original = serde_json::to_vec(&record).unwrap();
            fs::write(folder.join("record.json"), &original).unwrap();
            let data = root.join("data").join(id);
            fs::create_dir(&data).unwrap();
            fs::write(data.join("settings.json"), b"settings").unwrap();
            let grant = root.join("authorizations").join(format!("{id}.json"));
            fs::write(&grant, b"old grant").unwrap();
            let repo = Repository::open(root.clone()).unwrap();
            assert!(matches!(repo.detail(id), Err(Error::NotFound)));
            let archive = fs::read_dir(root.join("retired"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(fs::read(archive.join("record.json")).unwrap(), original);
            assert_eq!(fs::read(data.join("settings.json")).unwrap(), b"settings");
            assert_eq!(fs::read(grant).unwrap(), b"old grant");
            let mut reinstall = package("2.0.0");
            reinstall.manifest.id = id.into();
            assert!(
                repo.install(input(&save(dir.path(), &reinstall), None))
                    .is_err()
            );
            assert_eq!(
                Repository::open(root.clone())
                    .unwrap()
                    .list()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(fs::read_dir(root.join("retired")).unwrap().count(), 1);
        }
    }
}
#[test]
fn old_standard_views_retire_before_sdk_decoding_and_cannot_be_reinstalled() {
    let surfaces = std::iter::once(json!({"kind":"monitor","sections":["overview"]})).chain(
        [
            "overview",
            "disks",
            "network",
            "processes",
            "ports",
            "services",
            "logs",
        ]
        .map(|s| json!({"kind":"operations","sections":[s]})),
    );
    for surface in surfaces {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plugins");
        let repo = Repository::open(root.clone()).unwrap();
        repo.install(input(&save(dir.path(), &ui_package("1.0.0")), None))
            .unwrap();
        let (original, folder) = replace_surface(&root, "current", surface.clone());
        let payload = fs::read(folder.join("ui.json")).unwrap();
        let repo = Repository::open(root.clone()).unwrap();
        assert!(repo.list().unwrap().is_empty());
        assert_eq!(fs::read(folder.join("ui.json")).unwrap(), payload);
        let archive = fs::read_dir(root.join("retired"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(archive.join("record.json")).unwrap(), original);
        let mut reintroduced = ui_package("2.0.0");
        let ui = reintroduced
            .files
            .iter_mut()
            .find(|f| f.path == "ui.json")
            .unwrap();
        ui.content = STANDARD.encode(&payload);
        let digest_entry = reintroduced
            .manifest
            .files
            .iter_mut()
            .find(|f| f.path == "ui.json")
            .unwrap();
        digest_entry.size = payload.len() as u64;
        digest_entry.sha256 = digest(&payload);
        let error = IpcError::from(
            repo.install(input(&save(dir.path(), &reintroduced), None))
                .unwrap_err(),
        );
        assert!(error.message.contains("升级插件"));
        assert!(Repository::open(root).unwrap().list().unwrap().is_empty());
    }
}
#[test]
fn removed_backup_keeps_current_and_a_durable_package_after_future_upgrades() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    repo.install(input(&save(dir.path(), &ui_package("1.0.0")), None))
        .unwrap();
    let current = repo
        .install(input(
            &save(dir.path(), &ui_package("2.0.0")),
            Some("1.0.0"),
        ))
        .unwrap();
    repo.set_enabled("dev.example", true).unwrap();
    repo.settings_write("dev.example", &json!({"keep":42}))
        .unwrap();
    let (original, old_folder) = replace_surface(
        &root,
        "backup",
        json!({"kind":"operations","sections":["services"]}),
    );
    let repo = Repository::open(root.clone()).unwrap();
    let retained = repo.detail("dev.example").unwrap();
    assert_eq!(retained.revision, current.revision);
    assert!(retained.enabled);
    assert_eq!(retained.previous_version, None);
    assert_eq!(
        repo.settings_read("dev.example").unwrap(),
        json!({"keep":42})
    );
    assert!(repo.record("dev.example").unwrap().backup.is_none());
    let archive = fs::read_dir(root.join("retired"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read(archive.join("record.json")).unwrap(), original);
    let archived: Value =
        serde_json::from_slice(&fs::read(archive.join("package.sdplugin")).unwrap()).unwrap();
    let encoded = archived["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "ui.json")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    let bytes = STANDARD.decode(encoded).unwrap();
    assert_eq!(bytes, fs::read(old_folder.join("ui.json")).unwrap());
    repo.install(input(
        &save(dir.path(), &ui_package("3.0.0")),
        Some("2.0.0"),
    ))
    .unwrap();
    assert!(!old_folder.exists());
    assert!(archive.join("package.sdplugin").is_file());
    assert_eq!(
        Repository::open(root.clone())
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fs::read_dir(root.join("retired")).unwrap().count(), 1);
}
#[test]
fn old_payload_layout_is_retired_and_corruption_fails_without_changing_records() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    repo.install(input(&save(dir.path(), &ui_package("1.0.0")), None))
        .unwrap();
    let (original, folder) = replace_surface(
        &root,
        "current",
        json!({"kind":"monitor","sections":["overview"]}),
    );
    fs::write(folder.join("ui.json"), b"tampered").unwrap();
    assert!(Repository::open(root.clone()).is_err());
    assert_eq!(
        fs::read(root.join("packages/dev.example/record.json")).unwrap(),
        original
    );
    assert!(!root.join("retired").exists());
    let file: Value = serde_json::from_slice(&original).unwrap();
    let mut ui: Value = serde_json::from_slice(
        &STANDARD
            .decode(
                ui_package("1.0.0")
                    .files
                    .iter()
                    .find(|f| f.path == "ui.json")
                    .unwrap()
                    .content
                    .as_bytes(),
            )
            .unwrap(),
    )
    .unwrap();
    ui["pages"][0]["surface"] = json!({"kind":"monitor","sections":["overview"]});
    fs::write(folder.join("ui.json"), serde_json::to_vec(&ui).unwrap()).unwrap();
    let legacy = root.join("packages/dev.example/versions");
    fs::create_dir(&legacy).unwrap();
    fs::rename(
        &folder,
        legacy.join(file["current"]["revision"].as_str().unwrap()),
    )
    .unwrap();
    assert!(Repository::open(root).unwrap().list().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn retirement_refuses_a_reparse_point_without_touching_its_target() {
    use std::os::windows::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    let repo = Repository::open(root.clone()).unwrap();
    repo.install(input(&save(dir.path(), &ui_package("1.0.0")), None))
        .unwrap();
    let (original, folder) = replace_surface(
        &root,
        "current",
        json!({"kind":"monitor","sections":["overview"]}),
    );
    let outside = dir.path().join("owned-outside");
    fs::rename(&folder, &outside).unwrap();
    fs::write(outside.join("keep"), b"user data").unwrap();
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:PLUGIN_TEST_LINK -Target $env:PLUGIN_TEST_TARGET | Out-Null"])
        .env("PLUGIN_TEST_LINK", &folder).env("PLUGIN_TEST_TARGET", &outside)
        .creation_flags(0x08000000).status().unwrap();
    assert!(status.success());
    assert!(Repository::open(root.clone()).is_err());
    assert_eq!(
        fs::read(root.join("packages/dev.example/record.json")).unwrap(),
        original
    );
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"user data");
    assert!(!root.join("retired").exists());
    fs::remove_dir(folder).unwrap();
}

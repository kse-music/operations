use super::*;
use serverdeck_core::{AppConfig, Theme};
use serverdeck_storage::Database;

struct Fixture {
    _dir: tempfile::TempDir,
    defaults: Locations,
    locator: PathBuf,
    target: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let defaults = Locations::unified(dir.path().join("profile"));
        let database = Database::open(defaults.data.join("serverdeck.sqlite3")).unwrap();
        database
            .save_config(&AppConfig {
                theme: Theme::Light,
                ..Default::default()
            })
            .unwrap();
        database
            .trust_key(
                "migration.example",
                22,
                "migration-public-key",
                "migration-fingerprint",
            )
            .unwrap();
        fs::create_dir_all(defaults.data.join("plugins/empty-data")).unwrap();
        fs::write(
            defaults.data.join("plugins/settings.json"),
            b"plugin settings",
        )
        .unwrap();
        fs::create_dir_all(&defaults.logs).unwrap();
        fs::write(defaults.logs.join("serverdeck.log"), b"old log").unwrap();
        fs::create_dir_all(defaults.webview.join("EBWebView")).unwrap();
        fs::write(defaults.webview.join("EBWebView/state"), b"webview state").unwrap();
        let locator = defaults.data.join(LOCATOR);
        let target = dir.path().join("new-profile");
        Self {
            _dir: dir,
            defaults,
            locator,
            target,
        }
    }
    fn open(&self) -> Profile {
        Profile::open(self.locator.clone(), self.defaults.clone()).unwrap()
    }
    fn copied(&self) -> Profile {
        let mut p = self.open();
        assert!(p.prepare(&self.target).unwrap());
        self.open()
    }
}

#[test]
fn migration_preserves_preferences_plugins_logs_webview_and_empty_directories_until_ready() {
    let fixture = Fixture::new();
    let mut profile = fixture.copied();
    assert_eq!(profile.locations().data, fixture.target);
    assert!(fixture.defaults.data.join("serverdeck.sqlite3").is_file());
    assert_eq!(
        Database::open(fixture.target.join("serverdeck.sqlite3"))
            .unwrap()
            .load_config()
            .unwrap()
            .theme,
        Theme::Light
    );
    assert_eq!(
        Database::open(fixture.target.join("serverdeck.sqlite3"))
            .unwrap()
            .trusted_key("migration.example", 22)
            .unwrap()
            .as_deref(),
        Some("migration-public-key")
    );
    assert_eq!(
        fs::read(fixture.target.join("plugins/settings.json")).unwrap(),
        b"plugin settings"
    );
    assert!(fixture.target.join("plugins/empty-data").is_dir());
    assert_eq!(
        fs::read(fixture.target.join("logs/serverdeck.log")).unwrap(),
        b"old log"
    );
    assert_eq!(
        fs::read(fixture.target.join("webview/EBWebView/state")).unwrap(),
        b"webview state"
    );
    profile.ready().unwrap();
    assert!(!fixture.defaults.data.join("serverdeck.sqlite3").exists());
    assert!(!fixture.defaults.webview.exists());
    assert!(fixture.locator.is_file());
    assert_eq!(fixture.open().locations().data, fixture.target);
}

#[test]
fn completion_notice_is_not_replayed_by_ready_or_later_launches() {
    let fixture = Fixture::new();
    let mut profile = fixture.copied();
    let completion = profile.ready().unwrap().notice.unwrap();
    assert!(completion.contains("迁移完成"));
    let locator = fs::read(&fixture.locator).unwrap();
    assert!(profile.ready().unwrap().notice.is_none());
    assert_eq!(profile.info().notice.as_deref(), Some(completion.as_str()));
    for _ in 0..2 {
        let mut reopened = fixture.open();
        assert_eq!(reopened.locations().data, fixture.target);
        assert!(reopened.state.migration.is_none());
        assert_eq!(reopened.info().notice.as_deref(), Some(completion.as_str()));
        assert!(reopened.ready().unwrap().notice.is_none());
        assert_eq!(fs::read(&fixture.locator).unwrap(), locator);
        assert!(fixture.target.join("serverdeck.sqlite3").is_file());
    }
}

#[test]
fn startup_rollback_notice_is_reported_once_and_retained_as_history() {
    let fixture = Fixture::new();
    fixture.copied();
    let mut profile = fixture.open();
    let notice = profile.ready().unwrap().notice.unwrap();
    assert!(notice.contains("恢复旧目录"));
    assert!(profile.ready().unwrap().notice.is_none());
    let mut reopened = fixture.open();
    assert_eq!(reopened.info().notice.as_deref(), Some(notice.as_str()));
    assert!(reopened.ready().unwrap().notice.is_none());
    assert!(fixture.target.join("serverdeck.sqlite3").is_file());
    assert!(fixture.defaults.data.join("serverdeck.sqlite3").is_file());
}

#[test]
fn startup_copy_failure_notice_is_reported_once_without_losing_the_reason() {
    let fixture = Fixture::new();
    fixture.open().prepare(&fixture.target).unwrap();
    fs::create_dir(&fixture.target).unwrap();
    fs::write(fixture.target.join("keep"), b"unrelated").unwrap();
    let mut profile = fixture.open();
    let notice = profile.ready().unwrap().notice.unwrap();
    assert!(notice.contains("数据迁移未完成"));
    assert!(notice.contains("旧数据未删除"));
    assert!(profile.ready().unwrap().notice.is_none());
    assert_eq!(
        fixture.open().info().notice.as_deref(),
        Some(notice.as_str())
    );
    assert_eq!(fs::read(fixture.target.join("keep")).unwrap(), b"unrelated");
    assert!(fixture.defaults.data.join("serverdeck.sqlite3").is_file());
}

#[test]
fn failed_candidate_startup_rolls_back_without_deleting_either_copy() {
    let fixture = Fixture::new();
    fixture.copied();
    let profile = fixture.open();
    assert_eq!(profile.locations(), &fixture.defaults);
    assert!(profile.info().notice.unwrap().contains("恢复旧目录"));
    assert!(fixture.target.join("serverdeck.sqlite3").exists());
    assert!(fixture.defaults.data.join("serverdeck.sqlite3").exists());
}

#[test]
fn destination_created_after_confirmation_is_not_overwritten() {
    let fixture = Fixture::new();
    fixture.open().prepare(&fixture.target).unwrap();
    fs::create_dir(&fixture.target).unwrap();
    fs::write(fixture.target.join("keep"), b"unrelated").unwrap();
    assert_eq!(fixture.open().locations(), &fixture.defaults);
    assert_eq!(fs::read(fixture.target.join("keep")).unwrap(), b"unrelated");
}

#[test]
fn corrupted_database_never_becomes_active() {
    let fixture = Fixture::new();
    fixture.open().prepare(&fixture.target).unwrap();
    fs::write(
        fixture.defaults.data.join("serverdeck.sqlite3"),
        b"corrupt database",
    )
    .unwrap();
    let profile = fixture.open();
    assert_eq!(profile.locations(), &fixture.defaults);
    assert!(profile.info().notice.unwrap().contains("旧数据未删除"));
    assert!(!fixture.target.exists());
}

#[test]
fn modified_source_is_retained_and_committed_target_stays_active() {
    let fixture = Fixture::new();
    let mut profile = fixture.copied();
    fs::write(
        fixture.defaults.data.join("plugins/settings.json"),
        b"changed after copying",
    )
    .unwrap();
    assert!(
        profile
            .ready()
            .unwrap()
            .notice
            .unwrap()
            .contains("清理未完成")
    );
    assert_eq!(fixture.open().locations().data, fixture.target);
    assert!(
        fixture
            .open()
            .ready()
            .unwrap()
            .notice
            .unwrap()
            .contains("清理未完成")
    );
    assert_eq!(
        fs::read(fixture.defaults.data.join("plugins/settings.json")).unwrap(),
        b"changed after copying"
    );
    // Restoring the original allows idempotent retry without reverting to the source.
    fs::write(
        fixture.defaults.data.join("plugins/settings.json"),
        b"plugin settings",
    )
    .unwrap();
    profile.ready().unwrap();
    assert!(!fixture.defaults.data.join("plugins/settings.json").exists());
}

#[test]
fn nested_nonempty_relative_and_alias_targets_are_handled_without_mutation() {
    let fixture = Fixture::new();
    let mut profile = fixture.open();
    assert!(profile.preview(Path::new("relative")).is_err());
    assert!(
        profile
            .preview(&fixture.defaults.data.join("nested"))
            .is_err()
    );
    assert!(
        profile
            .preview(fixture.defaults.data.parent().unwrap())
            .is_err()
    );
    assert!(!profile.prepare(&fixture.defaults.data.join(".")).unwrap());
    assert!(!fixture.locator.exists());
    #[cfg(windows)]
    assert!(
        !profile
            .prepare(&PathBuf::from(
                fixture.defaults.data.to_string_lossy().to_uppercase()
            ))
            .unwrap()
    );
}

#[test]
fn empty_target_and_missing_parent_are_supported() {
    let fixture = Fixture::new();
    let target = fixture.target.join("nested/profile");
    fixture.open().prepare(&target).unwrap();
    let mut profile = fixture.open();
    assert_eq!(profile.locations().data, target);
    profile.ready().unwrap();
}

#[test]
fn interruption_during_copy_resumes_from_verified_files() {
    let fixture = Fixture::new();
    let mut profile = fixture.open();
    profile.prepare(&fixture.target).unwrap();
    let mut job = profile.state.migration.clone().unwrap();
    job.files = profile.inventory(&job.source, true).unwrap();
    let stage = Profile::staging(&job).unwrap();
    fs::create_dir_all(stage.join("plugins")).unwrap();
    fs::write(stage.join("plugins/settings.json"), b"plugin settings").unwrap();
    profile.state.migration = Some(job);
    profile.persist().unwrap();
    let mut resumed = fixture.open();
    assert_eq!(resumed.locations().data, fixture.target);
    resumed.ready().unwrap();
}

#[test]
fn corrupted_staging_is_rejected_and_retained() {
    let fixture = Fixture::new();
    let mut profile = fixture.open();
    profile.prepare(&fixture.target).unwrap();
    let job = profile.state.migration.clone().unwrap();
    let stage = Profile::staging(&job).unwrap();
    fs::create_dir_all(&stage).unwrap();
    fs::write(stage.join("serverdeck.sqlite3"), b"partial").unwrap();
    assert_eq!(fixture.open().locations(), &fixture.defaults);
    assert!(stage.join("serverdeck.sqlite3").exists());
}

#[test]
fn unavailable_custom_directory_does_not_create_an_empty_database() {
    let fixture = Fixture::new();
    let mut profile = fixture.copied();
    profile.ready().unwrap();
    fs::rename(&fixture.target, fixture.target.with_extension("offline")).unwrap();
    assert!(Profile::open(fixture.locator.clone(), fixture.defaults.clone()).is_err());
    assert!(!fixture.target.exists());
}

#[test]
fn returning_to_default_retains_locator_and_migrates_back() {
    let fixture = Fixture::new();
    let mut profile = fixture.copied();
    profile.ready().unwrap();
    profile.prepare(&fixture.defaults.data).unwrap();
    let mut back = fixture.open();
    assert_eq!(back.locations().data, fixture.defaults.data);
    assert!(fixture.locator.is_file());
    back.ready().unwrap();
    assert!(!fixture.target.join("serverdeck.sqlite3").exists());
    assert_eq!(fixture.open().locations().data, fixture.defaults.data);
}

#[test]
fn new_install_keeps_unified_locations_on_subsequent_launch() {
    let dir = tempfile::tempdir().unwrap();
    let defaults = Locations {
        data: dir.path().join("data"),
        logs: dir.path().join("old-logs"),
        webview: dir.path().join("old-webview"),
    };
    let locator = defaults.data.join(LOCATOR);
    let profile = Profile::open(locator.clone(), defaults.clone()).unwrap();
    Database::open(defaults.data.join("serverdeck.sqlite3")).unwrap();
    profile.record_initialized().unwrap();
    assert_eq!(
        Profile::open(locator, defaults.clone())
            .unwrap()
            .locations(),
        &Locations::unified(defaults.data)
    );
}

#[test]
fn source_links_are_rejected() {
    let fixture = Fixture::new();
    let link = fixture.defaults.data.join("plugins/linked");
    #[cfg(windows)]
    {
        // Junction creation does not require Developer Mode or symlink privilege.
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(fixture.defaults.logs.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        if !result.status.success() {
            // Restricted accounts may not create reparse points. Use an existing OS
            // junction read-only, without traversing or deleting it.
            use std::os::windows::fs::MetadataExt;
            let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            let existing = [
                PathBuf::from(format!("{drive}\\Documents and Settings")),
                PathBuf::from(format!("{drive}\\Users\\All Users")),
            ]
            .into_iter()
            .find(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_attributes() & 0x400 != 0))
            .expect("Windows reparse fixture unavailable");
            let mut profile = fixture.open();
            profile.state.active.webview = existing.clone();
            assert!(matches!(
                profile.preview(&fixture.target),
                Err(Error::Validation(_))
            ));
            assert!(matches!(
                check_path(&existing.join("unopened-child")),
                Err(Error::Validation(_))
            ));
            return;
        }
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&fixture.defaults.logs, &link).unwrap();
    assert!(fixture.open().preview(&fixture.target).is_err());
    // Non-recursive junction/symlink removal only; never traverse its target.
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(unix)]
    fs::remove_file(&link).unwrap();
}

#[test]
fn insufficient_space_and_size_overflow_are_rejected() {
    assert!(ensure_capacity(1024, 1024 + RESERVE - 1).is_err());
    assert!(ensure_capacity(1024, 1024 + RESERVE).is_ok());
    assert!(ensure_capacity(u64::MAX, u64::MAX).is_err());
}

#[test]
fn dedicated_directory_directly_under_a_drive_root_is_allowed() {
    let fixture = Fixture::new();
    let profile = fixture.open();
    let drive = fixture.target.ancestors().last().unwrap();
    assert!(profile.target(drive).is_err());
    // Path validation only: no writes outside the isolated fixture directory.
    let dedicated = drive.join(format!("ServerDeck-test-{}", uuid::Uuid::new_v4()));
    assert!(profile.target(&dedicated).is_ok());
}

#[cfg(windows)]
#[test]
fn hashing_waits_for_a_shared_writer_to_finish() {
    use std::{io::Seek, sync::mpsc, time::Duration};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("webview-state");
    let mut writer = File::create(&path).unwrap();
    writer.write_all(b"initial").unwrap();
    let (sender, receiver) = mpsc::channel();
    let worker_path = path.clone();
    let worker = std::thread::spawn(move || sender.send(hash(&worker_path)).unwrap());
    let early = receiver.recv_timeout(Duration::from_millis(200));
    writer.rewind().unwrap();
    writer.write_all(b"settled").unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    let premature = early.is_ok();
    let actual = early
        .unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(5)).unwrap())
        .unwrap();
    worker.join().unwrap();
    assert!(
        !premature,
        "migration read a file whose writer was still open"
    );
    assert_eq!(actual, hash(&path).unwrap());
}

#[cfg(windows)]
#[test]
fn migration_reader_prevents_writes_and_replacement_until_released() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("webview-state");
    fs::write(&path, b"settled").unwrap();
    let reader = read_source(&path).unwrap();
    assert!(File::open(&path).is_ok());
    let write_error = File::options().write(true).open(&path).unwrap_err();
    assert_eq!(write_error.raw_os_error(), Some(32));
    let rename_error = fs::rename(&path, dir.path().join("renamed")).unwrap_err();
    assert_eq!(rename_error.raw_os_error(), Some(32));
    drop(reader);
    assert!(File::options().write(true).open(&path).is_ok());
    fs::rename(&path, dir.path().join("renamed")).unwrap();
}

#[cfg(windows)]
#[test]
fn first_launch_migration_waits_for_webview_writers_before_inventory() {
    use std::{io::Seek, sync::mpsc, time::Duration};

    let fixture = Fixture::new();
    fixture.open().prepare(&fixture.target).unwrap();
    let state = fixture.defaults.webview.join("EBWebView/state");
    let mut writer = File::options().write(true).open(&state).unwrap();
    writer.write_all(b"initial state").unwrap();
    let (sender, receiver) = mpsc::channel();
    let locator = fixture.locator.clone();
    let defaults = fixture.defaults.clone();
    let worker = std::thread::spawn(move || {
        assert!(sender.send(Profile::open(locator, defaults)).is_ok());
    });
    let early = receiver.recv_timeout(Duration::from_millis(200));
    writer.rewind().unwrap();
    writer.write_all(b"settled state").unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    let premature = early.is_ok();
    let mut profile = early
        .unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(10)).unwrap())
        .unwrap();
    worker.join().unwrap();
    assert!(
        !premature,
        "migration finished while a WebView writer was still open"
    );
    assert_eq!(
        profile.locations().data,
        fixture.target,
        "{:?}",
        profile.info().notice
    );
    assert_eq!(
        fs::read(fixture.target.join("webview/EBWebView/state")).unwrap(),
        b"settled state"
    );
    assert!(fixture.defaults.data.join("serverdeck.sqlite3").exists());
    profile.ready().unwrap();
    assert!(!state.exists());
}

#[cfg(windows)]
#[test]
fn occupied_source_falls_back_without_deleting_data() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    fixture.open().prepare(&fixture.target).unwrap();
    let lock = File::options()
        .read(true)
        .share_mode(0)
        .open(fixture.defaults.webview.join("EBWebView/state"))
        .unwrap();
    let profile = fixture.open();
    assert_eq!(profile.locations(), &fixture.defaults);
    let notice = profile.info().notice.unwrap();
    assert!(notice.contains("旧数据未删除"));
    assert!(notice.contains("后台进程写入或占用"));
    assert!(!fixture.target.exists());
    drop(lock);
    assert_eq!(
        fs::read(fixture.defaults.webview.join("EBWebView/state")).unwrap(),
        b"webview state"
    );
}

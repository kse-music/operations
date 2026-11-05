use std::{fs, io, path::Path};

use serverdeck_core::identity::{APPLICATION_ID, LEGACY_APPLICATION_ID};

fn directory_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = metadata.file_type().is_symlink();
            if linked || !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "应用标识迁移仅接受普通目录，不能使用链接或文件",
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Move a default profile atomically within the same parent, before opening its
/// database or webview. Existing populated profiles and custom paths are preserved.
pub fn migrate_legacy_directory(destination: &Path) -> io::Result<()> {
    if destination.file_name() != Some(APPLICATION_ID.as_ref()) {
        return Ok(());
    }
    if !destination.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "应用目录迁移需要绝对路径",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "应用目录缺少父目录"))?;
    let source = parent.join(LEGACY_APPLICATION_ID);
    if !directory_exists(&source)? {
        return Ok(());
    }
    if directory_exists(destination)? {
        if fs::read_dir(destination)?.next().transpose()?.is_some() {
            return Ok(());
        }
        // Non-recursive: a concurrent writer makes this fail instead of losing data.
        fs::remove_dir(destination)?;
    }
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Application;
    use serverdeck_core::Theme;

    #[tokio::test]
    async fn migration_preserves_database_plugin_revision_and_disabled_choice() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join(LEGACY_APPLICATION_ID);
        let new = directory.path().join(APPLICATION_ID);
        let app = Application::initialize(old.clone(), old.join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        let mut config = app.bootstrap().await.unwrap().config;
        config.theme = Theme::Light;
        app.save_config(config.clone()).await.unwrap();
        let id = "cn.hiboot.plugins.services";
        let plugin = app.plugins.detail(id).unwrap();
        app.plugins.set_enabled(id, false).unwrap();
        fs::write(old.join("logs/retained.log"), b"retained").unwrap();
        app.shutdown().await;
        drop(app);

        migrate_legacy_directory(&new).unwrap();
        assert!(!old.exists());
        assert_eq!(
            fs::read(new.join("logs/retained.log")).unwrap(),
            b"retained"
        );
        let restarted = Application::initialize(new.clone(), new.join("logs")).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        assert_eq!(restarted.bootstrap().await.unwrap().config, config);
        let migrated = restarted.plugins.detail(id).unwrap();
        assert_eq!(migrated.revision, plugin.revision);
        assert!(!migrated.enabled);
        assert!(restarted.plugins.grant(id).unwrap().is_some());
        restarted.shutdown().await;
        migrate_legacy_directory(&new).unwrap();
    }

    #[test]
    fn empty_destination_can_migrate_but_populated_destination_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join(LEGACY_APPLICATION_ID);
        let new = directory.path().join(APPLICATION_ID);
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(old.join("settings"), b"old").unwrap();
        fs::write(new.join("settings"), b"new").unwrap();
        migrate_legacy_directory(&new).unwrap();
        assert_eq!(fs::read(old.join("settings")).unwrap(), b"old");
        assert_eq!(fs::read(new.join("settings")).unwrap(), b"new");
        fs::remove_file(new.join("settings")).unwrap();
        migrate_legacy_directory(&new).unwrap();
        assert_eq!(fs::read(new.join("settings")).unwrap(), b"old");
    }

    #[test]
    fn custom_paths_are_not_migrated_and_profile_files_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join(LEGACY_APPLICATION_ID);
        let new = directory.path().join(APPLICATION_ID);
        fs::create_dir(&old).unwrap();
        let custom = directory.path().join("owned-qa-profile");
        migrate_legacy_directory(&custom).unwrap();
        assert!(old.exists());
        assert!(!custom.exists());
        fs::write(&new, b"existing-file").unwrap();
        assert!(migrate_legacy_directory(&new).is_err());
        assert_eq!(fs::read(&new).unwrap(), b"existing-file");
    }

    #[cfg(windows)]
    #[test]
    fn junction_profiles_are_rejected_without_touching_their_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("user-data");
        let old = directory.path().join(LEGACY_APPLICATION_ID);
        let new = directory.path().join(APPLICATION_ID);
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), b"retained").unwrap();
        let create_link = |link: &Path| {
            assert!(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command",
                    "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:IDENTITY_TEST_LINK -Target $env:IDENTITY_TEST_TARGET | Out-Null"])
                .env("IDENTITY_TEST_LINK", link)
                .env("IDENTITY_TEST_TARGET", &target)
                .status().unwrap().success());
        };
        create_link(&old);
        assert!(migrate_legacy_directory(&new).is_err());
        fs::remove_dir(&old).unwrap();
        fs::create_dir(&old).unwrap();
        create_link(&new);
        assert!(migrate_legacy_directory(&new).is_err());
        fs::remove_dir(&new).unwrap();
        assert_eq!(fs::read(target.join("keep")).unwrap(), b"retained");
        assert!(old.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_profiles_are_rejected_without_touching_their_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("user-data");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), b"retained").unwrap();
        std::os::unix::fs::symlink(&target, directory.path().join(LEGACY_APPLICATION_ID)).unwrap();
        assert!(migrate_legacy_directory(&directory.path().join(APPLICATION_ID)).is_err());
        assert_eq!(fs::read(target.join("keep")).unwrap(), b"retained");
    }
}

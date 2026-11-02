use serverdeck_storage::Database;

#[test]
fn quick_copy_paste_is_opt_in_and_survives_reopen() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("settings.sqlite3");
    let database = Database::open(&path).expect("open");
    let mut config = database.load_config().expect("load default config");
    assert!(!config.terminal.quick_copy_paste);
    config.terminal.quick_copy_paste = true;
    database.save_config(&config).expect("enable");
    let reopened = Database::open(&path).expect("reopen");
    assert!(
        reopened
            .load_config()
            .expect("load enabled")
            .terminal
            .quick_copy_paste
    );
    config.terminal.quick_copy_paste = false;
    reopened.save_config(&config).expect("disable");
    assert!(
        !Database::open(&path)
            .expect("reopen disabled")
            .load_config()
            .expect("load disabled")
            .terminal
            .quick_copy_paste
    );
}

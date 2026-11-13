use super::*;

fn fixture() -> (tempfile::TempDir, LocalRecycle) {
    let root = std::env::var_os("SERVERDECK_RECYCLE_TEST_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let directory = tempfile::tempdir_in(root).unwrap();
    let parent = directory.path().canonicalize().unwrap();
    std::fs::write(parent.join("中文 空格.txt"), b"recycle fixture").unwrap();
    let input = LocalRecycle {
        parent: parent.to_str().unwrap().into(),
        paths: vec![parent.join("中文 空格.txt").to_str().unwrap().into()],
        confirmed: true,
    };
    (directory, input)
}

#[test]
fn validation_rejects_unconfirmed_empty_duplicate_outside_missing_and_root_targets() {
    let (_directory, valid) = fixture();
    assert_eq!(validate(&valid).unwrap().len(), 1);
    let mut invalid = Vec::new();
    let mut input = valid.clone();
    input.confirmed = false;
    invalid.push(input);
    let mut input = valid.clone();
    input.paths.clear();
    invalid.push(input);
    let mut input = valid.clone();
    input.paths.push(input.paths[0].clone());
    invalid.push(input);
    let mut input = valid.clone();
    input.paths = vec![input.parent.clone()];
    invalid.push(input);
    let mut input = valid.clone();
    input.paths = vec![
        Path::new(&input.parent)
            .join("missing")
            .to_str()
            .unwrap()
            .into(),
    ];
    invalid.push(input);
    let mut input = valid.clone();
    input.paths = vec![
        Path::new(&input.parent)
            .join("../outside")
            .to_str()
            .unwrap()
            .into(),
    ];
    invalid.push(input);
    let mut input = valid.clone();
    input.paths = vec![input.paths[0].clone(); 257];
    invalid.push(input);
    let mut input = valid.clone();
    input.paths[0].push_str(":stream");
    invalid.push(input);
    for input in invalid {
        assert!(validate(&input).is_err(), "{input:?}");
        assert!(Path::new(&valid.paths[0]).exists());
    }
    assert!(
        serde_json::from_str::<LocalRecycle>(
            r#"{"parent":"C:\\","paths":[],"confirmed":true,"permanent":true}"#
        )
        .is_err()
    );
}

#[test]
fn permanent_delete_proposals_and_shell_item_failures_are_rejected() {
    let state = Rc::new(RefCell::new(Outcome::default()));
    let sink: IFileOperationProgressSink = RecycleSink(state.clone()).into();
    unsafe {
        assert!(sink.PreDeleteItem(0, None::<&IShellItem>).is_err());
        assert_eq!(state.borrow().error, Some(E_ABORT));
        state.borrow_mut().error = None;
        sink.PostDeleteItem(
            TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32,
            None::<&IShellItem>,
            E_FAIL,
            None::<&IShellItem>,
        )
        .unwrap();
    }
    assert_eq!(state.borrow().error, Some(E_FAIL));
}

#[test]
fn native_locked_file_is_preserved_and_reported_without_permanent_deletion() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_directory, input) = fixture();
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&input.paths[0])
        .unwrap();
    assert!(recycle(input.clone()).is_err());
    assert!(Path::new(&input.paths[0]).exists());
    drop(locked);
    assert_eq!(std::fs::read(&input.paths[0]).unwrap(), b"recycle fixture");
}

// Real Windows Shell recycling and restoration, restricted to this test's owned fixture.
#[test]
fn native_recycle_preserves_files_directories_and_junction_targets_and_allows_restore() {
    let (_directory, mut input) = fixture();
    let parent = PathBuf::from(&input.parent);
    let folder = parent.join("nested folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("keep.txt"), b"nested fixture").unwrap();
    let outside = tempfile::tempdir_in(parent.parent().unwrap()).unwrap();
    std::fs::write(outside.path().join("untouched.txt"), b"outside fixture").unwrap();
    let junction = folder.join("outside-junction");
    let created = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(created.status.success(), "junction fixture creation failed");
    let selected_junction = parent.join("selected-junction");
    let created = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&selected_junction)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        created.status.success(),
        "selected junction creation failed"
    );
    input.paths.push(folder.to_str().unwrap().into());
    input.paths.push(selected_junction.to_str().unwrap().into());
    let paths = validate(&input).unwrap();
    let _apartment = Apartment::new().unwrap();
    let recycled = perform(&paths).unwrap();
    assert_eq!(recycled.len(), paths.len());
    assert!(paths.iter().all(|path| !path.exists()));
    assert_eq!(
        std::fs::read(outside.path().join("untouched.txt")).unwrap(),
        b"outside fixture"
    );
    // Restore only these exact recycled objects, never enumerate or empty the user's bin.
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).unwrap();
        operation
            .SetOperationFlags(FOF_NO_UI | FOFX_EARLYFAILURE)
            .unwrap();
        let destination = item(&parent).unwrap();
        for (recycled, original) in recycled.iter().zip(&paths) {
            let name: Vec<u16> = original
                .file_name()
                .unwrap()
                .encode_wide()
                .chain(Some(0))
                .collect();
            operation
                .MoveItem(
                    recycled,
                    &destination,
                    PCWSTR(name.as_ptr()),
                    None::<&IFileOperationProgressSink>,
                )
                .unwrap();
        }
        operation.PerformOperations().unwrap();
        assert!(!operation.GetAnyOperationsAborted().unwrap().as_bool());
    }
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"recycle fixture");
    assert_eq!(
        std::fs::read(folder.join("keep.txt")).unwrap(),
        b"nested fixture"
    );
    assert_eq!(
        std::fs::read(outside.path().join("untouched.txt")).unwrap(),
        b"outside fixture"
    );
    // Remove just the restored junction before TempDir cleans up its owned normal directory.
    std::fs::remove_dir(junction).unwrap();
    std::fs::remove_dir(selected_junction).unwrap();
}

#[path = "src/skill_format.rs"]
mod skill_format;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
fn ordinary(path: &Path, directory: bool) {
    let metadata =
        fs::symlink_metadata(path).unwrap_or_else(|e| panic!("Skill path {}: {e}", path.display()));
    assert!(!metadata.file_type().is_symlink(), "Linked Skill path");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        assert_eq!(metadata.file_attributes() & 0x400, 0, "Reparse Skill path");
    }
    assert!(
        if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        },
        "Invalid Skill path"
    );
}
fn files(root: &Path, directory: &Path, result: &mut Vec<PathBuf>) {
    ordinary(directory, true);
    let mut entries = fs::read_dir(directory)
        .expect("read Skill resources")
        .map(|e| e.expect("Skill entry").path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let metadata = fs::symlink_metadata(&path).expect("Skill metadata");
        if metadata.is_dir() {
            files(root, &path, result);
        } else {
            ordinary(&path, false);
            assert!(path.starts_with(root));
            result.push(path);
            assert!(result.len() <= 128, "Too many Skill resources");
        }
    }
}
fn main() {
    let directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest")).join("../skills");
    ordinary(&directory, true);
    let root = directory.canonicalize().expect("Skill root");
    println!("cargo:rerun-if-changed={}", root.display());
    println!("cargo:rerun-if-changed=src/skill_format.rs");
    ordinary(&root, true);
    let mut directories = fs::read_dir(&root)
        .expect("Skill directories")
        .map(|e| e.expect("Skill directory").path())
        .collect::<Vec<_>>();
    directories.sort();
    assert!(directories.len() <= 32, "Too many Skills");
    let mut skills = String::from("pub static SKILLS: &[Skill] = &[\n");
    let mut resources = String::from("pub static RESOURCES: &[Resource] = &[\n");
    let mut total = 0;
    for directory in directories {
        ordinary(&directory, true);
        let mut paths = Vec::new();
        files(&root, &directory, &mut paths);
        let main = directory.join("SKILL.md");
        ordinary(&main, false);
        let text = fs::read_to_string(&main).expect("UTF-8 Skill");
        let (name, description, _) =
            skill_format::metadata(&text).expect("Valid Skill frontmatter");
        assert_eq!(
            directory.file_name().and_then(|s| s.to_str()),
            Some(name.as_str()),
            "Skill name must match directory"
        );
        skills.push_str(&format!(
            "Skill {{name:{name:?},description:{description:?}}},\n"
        ));
        for path in paths {
            let text = fs::read_to_string(&path).expect("UTF-8 Skill resource");
            assert!(text.len() <= 32768, "Skill resource too large");
            total += text.len();
            assert!(total <= 262144, "Skill package too large");
            let relative = path
                .strip_prefix(&directory)
                .expect("Skill resource relative path")
                .to_string_lossy()
                .replace('\\', "/");
            resources.push_str(&format!(
                "Resource {{skill:{name:?},path:{relative:?},text:include_str!({:?})}},\n",
                path.to_string_lossy()
            ));
        }
    }
    skills.push_str("];\n");
    resources.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").expect("output")).join("skills.rs"),
        skills + &resources,
    )
    .expect("write Skill registry");
}

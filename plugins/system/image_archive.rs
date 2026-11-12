const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
fn image_id(id: &str) -> Result<(), ApiError> {
    let id = id.strip_prefix("sha256:").unwrap_or(id);
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("需要完整的 64 位镜像 ID"));
    }
    Ok(())
}
use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    platform::{Command, quote},
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Archive {
    Import {
        file_name: String,
        confirmed: bool,
    },
    Export {
        id: String,
        reference: String,
        file_name: String,
        confirmed: bool,
    },
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("DOCKER_INPUT", message)
}

fn file_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty()
        || name.len() > 240
        || matches!(name, "." | "..")
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(invalid("镜像归档文件名无效"));
    }
    Ok(())
}

pub fn command(archive: &Archive, nonce: &str) -> Result<(String, String, String), ApiError> {
    if nonce.len() != 36 || !nonce.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err(invalid("镜像任务标识无效"));
    }
    let (name, confirmed) = match archive {
        Archive::Import {
            file_name,
            confirmed,
        }
        | Archive::Export {
            file_name,
            confirmed,
            ..
        } => (file_name, confirmed),
    };
    if !confirmed {
        return Err(invalid("镜像导入导出需要明确确认"));
    }
    file_name(name)?;
    let directory = format!("/tmp/serverdeck-image-{nonce}");
    let path = format!("{directory}/{name}");
    let operation = match archive {
        Archive::Import {..} => r#"
while ! test -e "$sd_path" && ! test -L "$sd_path"; do run_child sleep 1 || exit; done
if test -L "$sd_path" || ! test -f "$sd_path"; then echo 'Archive must be a regular file' >&2; exit 1; fi
run_child docker --host unix://$sd_socket image load --input "$sd_path" || exit
"#.into(),
        Archive::Export {id, reference, ..} => {
            image_id(id)?;
            if !name.to_ascii_lowercase().ends_with(".tar") { return Err(invalid("导出文件名必须以 .tar 结尾（不压缩）")); }
            if reference.is_empty() || reference.len() > 1024 || reference.starts_with('-')
                || reference.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err(invalid("镜像引用无效"));
            }
            let id = format!("sha256:{}", id.strip_prefix("sha256:").unwrap_or(id));
            format!(r#"
sd_reference={reference}
sd_actual=$(d image inspect --format '{{{{.Id}}}}' -- "$sd_reference") || exit
test "$sd_actual" = {id} || {{ echo 'Image reference changed; refresh the image list' >&2; exit 1; }}
run_child docker --host unix://$sd_socket image save --output "$sd_path" "$sd_reference" || exit
sd_actual=$(d image inspect --format '{{{{.Id}}}}' -- "$sd_reference") || exit
test "$sd_actual" = {id} || {{ echo 'Image reference changed during export' >&2; exit 1; }}
"#, reference=quote(reference)?, id=quote(&id)?)
        }
    };
    // The stream owns this private directory until the native transfer finishes.
    // Unexpected files are retained; cleanup never recursively removes a directory.
    let script = format!(
        r#"{PRELUDE}
umask 077
sd_dir={directory}; sd_path={path}; sd_child=
test -d /tmp && ! test -L /tmp || {{ echo 'Temporary directory is unavailable or linked' >&2; exit 1; }}
mkdir -- "$sd_dir" || exit
cleanup() {{
    sd_status=$?
    if test -n "$sd_child"; then
        if kill -0 "$sd_child" 2>/dev/null; then kill -TERM "$sd_child" || sd_status=1; fi
        wait "$sd_child" 2>/dev/null
    fi
    if test -L "$sd_dir" || ! rm -f -- "$sd_path" || ! rmdir -- "$sd_dir"; then
        printf 'Archive cleanup incomplete: %s\n' "$sd_dir" >&2; sd_status=1
    fi
    exit "$sd_status"
}}
trap cleanup 0
trap 'exit 1' HUP INT TERM
run_child() {{ "$@" & sd_child=$!; wait "$sd_child"; sd_result=$?; sd_child=; return "$sd_result"; }}
printf 'SD_ARCHIVE_PREPARED:{nonce}\n'
{operation}
printf '\nSD_ARCHIVE_READY:{nonce}\n'
while :; do run_child sleep 1 || exit; done
"#,
        directory = quote(&directory)?,
        path = quote(&path)?
    );
    Command::script(&script).validate()?;
    Ok((script, directory, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_plugin_sdk::serde_json::{self, json};
    const NONCE: &str = "01234567-89ab-cdef-0123-456789abcdef";
    #[test]
    fn archive_contract_rejects_traversal_unknown_fields_and_missing_confirmation() {
        for name in [
            "",
            ".",
            "..",
            "../archive.tar",
            "/tmp/archive.tar",
            "a\\b.tar",
            "a\n.tar",
        ] {
            assert!(
                command(
                    &Archive::Import {
                        file_name: name.into(),
                        confirmed: true
                    },
                    NONCE
                )
                .is_err()
            );
        }
        assert!(
            command(
                &Archive::Import {
                    file_name: "archive.tar".into(),
                    confirmed: false
                },
                NONCE
            )
            .is_err()
        );
        assert!(
            command(
                &Archive::Import {
                    file_name: "archive.tar".into(),
                    confirmed: true
                },
                "../escape"
            )
            .is_err()
        );
        assert!(serde_json::from_value::<Archive>(json!({"kind":"import","fileName":"image.tar","confirmed":true,"path":"/etc/user-data"})).is_err());
        for (id, reference, name) in [
            ("short".into(), "repo:tag", "image.tar"),
            ("a".repeat(64), "--help", "image.tar"),
            ("a".repeat(64), "repo:tag", "image.tar.gz"),
        ] {
            assert!(
                command(
                    &Archive::Export {
                        id,
                        reference: reference.into(),
                        file_name: name.into(),
                        confirmed: true
                    },
                    NONCE
                )
                .is_err()
            );
        }
    }
    #[test]
    fn commands_keep_tags_and_quote_filenames_without_shell_expansion() {
        let (script, dir, path) = command(
            &Archive::Import {
                file_name: "镜像 '$(touch injected).tar".into(),
                confirmed: true,
            },
            NONCE,
        )
        .unwrap();
        assert!(script.contains(&quote(&path).unwrap()));
        assert!(path.starts_with(&dir));
        assert!(script.contains("image load --input \"$sd_path\" || exit"));
        let (script, _, _) = command(
            &Archive::Export {
                id: "a".repeat(64),
                reference: "registry:5000/app:tag".into(),
                file_name: "image.tar".into(),
                confirmed: true,
            },
            NONCE,
        )
        .unwrap();
        assert!(script.contains("image save --output \"$sd_path\" \"$sd_reference\" || exit"));
        assert!(script.contains("test \"$sd_actual\" = 'sha256:"));
        assert!(!script.contains("rm -rf"));
    }
    #[test]
    #[ignore = "requires local WSL sh; runs isolated shell fixtures without a Docker daemon"]
    fn shell_round_trip_failure_and_cleanup() {
        use std::{
            io::Write,
            process::{Command as Process, Stdio},
        };
        for (export, fail) in [(false, false), (true, false), (false, true), (true, true)] {
            let archive = if export {
                Archive::Export {
                    id: "a".repeat(64),
                    reference: "registry:5000/app:tag".into(),
                    file_name: "镜像 '$(touch injected).tar".into(),
                    confirmed: true,
                }
            } else {
                Archive::Import {
                    file_name: "镜像 '$(touch injected).tar".into(),
                    confirmed: true,
                }
            };
            let (script, dir, _) = command(&archive, NONCE).unwrap();
            let body = script
                .strip_prefix(PRELUDE)
                .unwrap()
                .replace(&dir, "'\"$sd_fixture\"'/job")
                .replace("docker --host unix://$sd_socket", "d")
                .replace(
                    "while :; do run_child sleep 1 || exit; done",
                    "test \"$(cat \"$sd_path\")\" = ARCHIVE || exit 8",
                );
            let setup = format!(
                r#"
sd_fixture=$(mktemp -d /tmp/sd-archive-qa-XXXXXXXX) || exit
mkdir() {{ command mkdir "$@" || return; if test {export} = false; then printf ARCHIVE > "$sd_path"; fi; }}
d() {{
    case "$1 $2" in
        'image inspect') if test {fail} = true; then printf 'sha256:wrong\n'; else printf 'sha256:{id}\n'; fi;;
        'image save') test "$3" = --output && test "$5" = registry:5000/app:tag || return 9; printf ARCHIVE > "$4";;
        'image load') test "$3" = --input && test "$(cat "$4")" = ARCHIVE || return 9; if test {fail} = true; then echo 'invalid archive' >&2; return 17; fi; printf 'Loaded image: fixture:tag\n';;
        *) return 9;;
    esac
}}
( {body} )
sd_result=$?
test ! -e "$sd_fixture/job" || exit 7
test ! -e injected || exit 6
rmdir -- "$sd_fixture" || exit 5
exit "$sd_result"
"#,
                id = "a".repeat(64)
            );
            let mut child = Process::new("wsl")
                .args(["--exec", "sh", "-s"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(setup.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert_eq!(
                output.status.success(),
                !fail,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).contains("SD_ARCHIVE_READY:"),
                !fail
            );
        }
    }

    #[test]
    #[ignore = "requires WSL Docker; creates and removes only one uniquely named temporary image"]
    fn live_image_save_load_round_trip() {
        use std::{
            io::Write,
            process::{Command as Process, Stdio},
            time::{SystemTime, UNIX_EPOCH},
        };
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let nonce = format!("{stamp:036x}");
        let import_nonce = format!("{:036x}", stamp + 1);
        let tag = format!("serverdeck-image-archive-qa:{nonce}");
        let (export, export_dir, _) = command(
            &Archive::Export {
                id: "a".repeat(64),
                reference: tag.clone(),
                file_name: "image.tar".into(),
                confirmed: true,
            },
            &nonce,
        )
        .unwrap();
        let export = export
            .replace(
                &quote(&format!("sha256:{}", "a".repeat(64))).unwrap(),
                "\"$sd_image\"",
            )
            .replace(
                "while :; do run_child sleep 1 || exit; done",
                "cp -- \"$sd_path\" \"$sd_qa/image.tar\" || exit",
            );
        let (import, import_dir, _) = command(
            &Archive::Import {
                file_name: "image.tar".into(),
                confirmed: true,
            },
            &import_nonce,
        )
        .unwrap();
        let import = import.replace(&format!("printf 'SD_ARCHIVE_PREPARED:{import_nonce}\\n'"), &format!("printf 'SD_ARCHIVE_PREPARED:{import_nonce}\\n'\ncp -- \"$sd_qa/image.tar\" \"$sd_path\" || exit"))
            .replace("while :; do run_child sleep 1 || exit; done", "exit 0");
        let script = format!(
            r#"
{PRELUDE}
sd_qa=$(mktemp -d /tmp/sd-archive-live-XXXXXXXX) || exit
sd_tag={tag}; sd_image=
qa_cleanup() {{
    sd_exit=$?
    if test -n "$sd_image"; then
        sd_current=$(d image inspect --format '{{{{.Id}}}}' "$sd_tag" 2>/dev/null)
        if test "$sd_current" = "$sd_image"; then d image rm "$sd_tag" >/dev/null || sd_exit=1; fi
    fi
    case "$sd_qa" in /tmp/sd-archive-live-????????)
        if test -d "$sd_qa" && ! test -L "$sd_qa"; then
            rm -f -- "$sd_qa/payload" "$sd_qa/rootfs.tar" "$sd_qa/image.tar" || sd_exit=1
            rmdir -- "$sd_qa" || sd_exit=1
        fi;; *) sd_exit=1;; esac
    exit "$sd_exit"
}}
trap qa_cleanup 0
printf '%s' {nonce} > "$sd_qa/payload" || exit
tar -C "$sd_qa" -cf "$sd_qa/rootfs.tar" payload || exit
sd_image=$(d image import "$sd_qa/rootfs.tar" "$sd_tag") || exit
( {export} ) || exit
test ! -e {export_dir} && test -s "$sd_qa/image.tar" || exit 8
d image rm "$sd_tag" >/dev/null || exit
if d image inspect "$sd_tag" >/dev/null 2>&1; then exit 7; fi
( {import} ) || exit
test ! -e {import_dir} || exit 6
sd_restored=$(d image inspect --format '{{{{.Id}}}}' "$sd_tag") || exit
test "$sd_restored" = "$sd_image" || exit 5
printf 'REAL_DOCKER_ROUND_TRIP_OK\n'
"#,
            tag = quote(&tag).unwrap(),
            nonce = quote(&nonce).unwrap(),
            export_dir = quote(&export_dir).unwrap(),
            import_dir = quote(&import_dir).unwrap()
        );
        let mut child = Process::new("wsl")
            .args(["--exec", "sh", "-s"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("REAL_DOCKER_ROUND_TRIP_OK"));
    }
}

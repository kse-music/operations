use serverdeck_plugin_sdk::{
    ApiError,
    backend::Context,
    platform::Request,
    serde_json::{self, Value, json},
};
#[path = "../../../image_archive.rs"]
mod archive;
use archive::{Archive, command, command_with_checks};
use serde::Deserialize;
use serverdeck_plugin_sdk::platform::quote;
fn invalid(message: &str) -> ApiError {
    ApiError::new("DOCKER_INPUT", message)
}

pub async fn open(context: &Context, host: &str, input: Value) -> Result<Value, ApiError> {
    let info = context.info().await?;
    let nonce = info["nonce"]
        .as_str()
        .ok_or_else(|| invalid("平台任务标识无效"))?;
    let (command, directory, path) = if input["kind"] == "receive" {
        receive_command(input, nonce)?
    } else {
        let archive: Archive =
            serde_json::from_value(input).map_err(|_| invalid("镜像导入导出请求无效"))?;
        if let Archive::Export { id, .. } = &archive {
            let identity = format!(
                "{}\nprintf 'SD_ARCHIVE_CONTENT:{nonce}:%s\\n' \"$sd_content_hash\"\n",
                content_command(id)?
            );
            command_with_checks(&archive, nonce, "", &identity)?
        } else {
            command(&archive, nonce)?
        }
    };
    let target = context
        .request(Request::Host {
            host_id: host.into(),
        })
        .await?;
    let binding = target["binding"]
        .as_str()
        .ok_or_else(|| invalid("主机绑定无效"))?;
    let stream = context
        .with_bindings(vec![binding.into()])
        .request(Request::StreamOpen {
            host_id: host.into(),
            command,
        })
        .await?;
    Ok(json!({"streamId":stream["id"],"directory":directory,"path":path,"nonce":nonce}))
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Receive {
    Receive {
        id: String,
        reference: String,
        content_sha256: String,
        file_name: String,
        expected_target_id: Option<String>,
        replace_confirmed: bool,
        confirmed: bool,
    },
}

fn receive_command(
    input: Value,
    nonce: &str,
) -> Result<(serverdeck_plugin_sdk::platform::Command, String, String), ApiError> {
    let Receive::Receive {
        id,
        reference,
        content_sha256,
        file_name,
        expected_target_id,
        replace_confirmed,
        confirmed,
    } = serde_json::from_value(input).map_err(|_| invalid("远程镜像接收请求无效"))?;
    crate::docker::image_id(&id)?;
    if content_sha256.len() != 64 || !content_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("来源镜像内容摘要无效"));
    }
    if !file_name.to_ascii_lowercase().ends_with(".tar") {
        return Err(invalid("远程传输归档必须以 .tar 结尾"));
    }
    let id = format!(
        "sha256:{}",
        id.strip_prefix("sha256:")
            .unwrap_or(&id)
            .to_ascii_lowercase()
    );
    if reference.is_empty()
        || reference.len() > 1024
        || reference.starts_with('-')
        || reference
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(invalid("镜像引用无效"));
    }
    let expected = if let Some(expected) = expected_target_id {
        crate::docker::image_id(&expected)?;
        format!(
            "sha256:{}",
            expected
                .strip_prefix("sha256:")
                .unwrap_or(&expected)
                .to_ascii_lowercase()
        )
    } else {
        String::new()
    };
    if !expected.is_empty() && expected != id && !replace_confirmed {
        return Err(invalid("替换目标镜像标签需要明确确认"));
    }
    let tagged = reference != id && reference != id.strip_prefix("sha256:").unwrap_or(&id);
    let before = if tagged {
        format!(
            r#"
sd_reference={reference}; sd_expected={expected}
sd_images=$(d image ls --all --no-trunc --format '{{{{.Repository}}}}:{{{{.Tag}}}} {{{{.ID}}}}') || exit
sd_actual=$(printf '%s\n' "$sd_images" | while IFS=' ' read -r sd_tag sd_image; do
    if test "$sd_tag" = "$sd_reference"; then printf '%s' "$sd_image"; break; fi
done)
test "$sd_actual" = "$sd_expected" || {{ echo 'Target image tag changed; check the target and confirm again' >&2; exit 1; }}
"#,
            reference = quote(&reference)?,
            expected = quote(&expected)?
        )
    } else {
        String::new()
    };
    let loaded_reference = if tagged {
        format!("sd_loaded_reference={}\n", quote(&reference)?)
    } else {
        r#"sd_loaded_reference=$(sed -n 's/^Loaded image ID: \(sha256:[0-9a-fA-F]*\)$/\1/p' "$sd_dir/.load-output")
test "${#sd_loaded_reference}" = 71 || { echo 'Loaded image reference is unavailable; check the target' >&2; exit 1; }
"#.into()
    };
    let after = format!(
        "{loaded_reference}{}\ntest \"$sd_content_hash\" = {} || {{ echo 'Loaded image content does not match the source; check the target' >&2; exit 1; }}\n",
        content_command_variable()?,
        quote(&content_sha256.to_ascii_lowercase())?
    );
    command_with_checks(
        &Archive::Import {
            file_name,
            confirmed,
        },
        nonce,
        &before,
        &after,
    )
}

// Hash content rather than the store-specific manifest/index/config ID. Empty
// legacy Config fields are omitted; nonempty settings and ordered layer hashes
// remain part of the identity. Only the digest leaves the remote shell.
const CONTENT_FORMAT: &str = r#"{{if and (index . "Os") (index . "Architecture") (eq (index (index . "RootFS") "Type") "layers")}}v1|{{json (index . "Os")}}|{{json (index . "Architecture")}}|{{with index . "Variant"}}{{json .}}{{else}}""{{end}}|{{with index . "OsVersion"}}{{json .}}{{else}}""{{end}}|{{json (index (index . "RootFS") "Type")}}|{{with index (index . "RootFS") "Layers"}}{{json .}}{{else}}[]{{end}}|{{range $key, $value := index . "Config"}}{{if and $value (ne (json $value) "0")}}{{json $key}}={{json $value}};{{end}}{{end}}{{end}}"#;
fn content_command(reference: &str) -> Result<String, ApiError> {
    content_command_for(&quote(reference)?)
}
fn content_command_variable() -> Result<String, ApiError> {
    content_command_for("\"$sd_loaded_reference\"")
}
fn content_command_for(reference: &str) -> Result<String, ApiError> {
    Ok(format!(
        r#"
sd_content=$(d image inspect --format {format} -- {reference}) || exit
test -n "$sd_content" || {{ echo 'Image content identity is unavailable' >&2; exit 1; }}
sd_content_hash=$(printf '%s' "$sd_content" | sha256sum) || exit
sd_content_hash=${{sd_content_hash%% *}}
"#,
        format = quote(CONTENT_FORMAT)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    const NONCE: &str = "01234567-89ab-cdef-0123-456789abcdef";
    fn request(expected: Option<&str>, replace: bool) -> Value {
        json!({"kind":"receive", "id":format!("sha256:{}", "a".repeat(64)),
            "reference":"registry:5000/app:v1", "fileName":"image.tar",
            "contentSha256":format!("{:x}", Sha256::digest(b"fixture-content")),
            "expectedTargetId":expected, "replaceConfirmed":replace, "confirmed":true})
    }

    #[test]
    fn receive_validates_ids_paths_and_explicit_replacement_confirmation() {
        let expected = format!("sha256:{}", "b".repeat(64));
        assert!(receive_command(request(Some(&expected), false), NONCE).is_err());
        assert!(receive_command(request(Some(&expected), true), NONCE).is_ok());
        let same = format!("sha256:{}", "a".repeat(64));
        assert!(receive_command(request(Some(&same), false), NONCE).is_ok());
        for (key, value) in [
            ("id", json!("short")),
            ("expectedTargetId", json!("short")),
            ("contentSha256", json!("short")),
            ("reference", json!("--help")),
            ("reference", json!("app:tag\ncommand")),
            ("fileName", json!("../user-data")),
            ("confirmed", json!(false)),
            ("unknown", json!(true)),
        ] {
            let mut input = request(None, false);
            input[key] = value;
            assert!(receive_command(input, NONCE).is_err(), "{key}");
        }
    }

    #[test]
    fn receive_checks_target_before_load_and_loaded_id_before_success() {
        let (command, _, _) = receive_command(request(None, false), NONCE).unwrap();
        let script = &command.args[1];
        let guard = script.find("Target image tag changed").unwrap();
        let load = script.find("image load --input").unwrap();
        let verify = script.find("Loaded image content does not match").unwrap();
        let ready = script.find("SD_ARCHIVE_READY").unwrap();
        assert!(guard < load && load < verify && verify < ready);
        assert!(script.contains("sd_expected=''"));
        assert!(!script.contains("rm -rf"));
        let mut input = request(None, false);
        input["reference"] = input["id"].clone();
        let (command, _, _) = receive_command(input, NONCE).unwrap();
        assert!(!command.args[1].contains("Target image tag changed"));
        assert!(command.args[1].contains("Loaded image content does not match"));
        assert!(command.args[1].contains("Loaded image ID:"));
        assert!(command.args[1].contains("-- \"$sd_loaded_reference\""));
    }

    #[test]
    #[ignore = "requires WSL Docker; uses only randomly named temporary images and files"]
    fn receive_live_verifies_content_with_different_source_id_and_untagged_load() {
        use std::{
            io::Write,
            process::{Command, Stdio},
            time::{SystemTime, UNIX_EPOCH},
        };
        for tagged in [true, false] {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let nonce = format!("{stamp:036x}");
            let tag = format!("serverdeck-receive-qa:{nonce}");
            let mut input = request(None, false);
            input["id"] = json!(format!("sha256:{}", "b".repeat(64)));
            input["reference"] = if tagged {
                json!(tag)
            } else {
                input["id"].clone()
            };
            let (command, directory, path) = receive_command(input.clone(), &nonce).unwrap();
            let body = command.args[1]
                .replace(&quote(input["contentSha256"].as_str().unwrap()).unwrap(), "\"$sd_qa_content\"")
                .replace(&format!("printf 'SD_ARCHIVE_PREPARED:{nonce}\\n'"),
                    &format!("printf 'SD_ARCHIVE_PREPARED:{nonce}\\n'\ncp -- \"$sd_qa/image.tar\" {} || exit", quote(&path).unwrap()))
                .replace("while :; do run_child sleep 1 || exit; done", "exit 0");
            let identity = content_command(&tag).unwrap();
            let script = format!(
                r#"
sd_qa=$(mktemp -d /tmp/sd-receive-live-XXXXXXXX) || exit
sd_qa_tag={tag}; sd_qa_image=
qa_cleanup() {{
    sd_status=$?
    if test -n "$sd_qa_image"; then docker image rm "$sd_qa_image" >/dev/null 2>&1 || sd_status=1; fi
    rm -f -- "$sd_qa/payload" "$sd_qa/rootfs.tar" "$sd_qa/image.tar" || sd_status=1
    rmdir -- "$sd_qa" || sd_status=1
    exit "$sd_status"
}}
trap qa_cleanup 0
printf 'content-verification-fixture' > "$sd_qa/payload" || exit
tar -C "$sd_qa" -cf "$sd_qa/rootfs.tar" payload || exit
sd_qa_image=$(docker image import --change 'ENV CONTENT_CHECK=kept' --change 'CMD ["echo","fixture"]' "$sd_qa/rootfs.tar" "$sd_qa_tag") || exit
d() {{ command docker "$@"; }}
{identity}
sd_qa_content=$sd_content_hash
if test {tagged} = true; then sd_export=$sd_qa_tag; else sd_export=$sd_qa_image; fi
docker image save --output "$sd_qa/image.tar" -- "$sd_export" || exit
docker image rm "$sd_qa_tag" >/dev/null || exit
( {body} ) || exit
test ! -e {directory} || exit 6
docker image inspect "$sd_qa_image" >/dev/null || exit
printf 'REAL_RECEIVE_CONTENT_VERIFIED\n'
"#,
                tag = quote(&tag).unwrap(),
                directory = quote(&directory).unwrap()
            );
            let mut child = Command::new("wsl")
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
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("REAL_RECEIVE_CONTENT_VERIFIED")
            );
        }
    }

    #[test]
    #[ignore = "requires WSL sh; isolated shell fixtures without a Docker daemon"]
    fn receive_shell_checks_conflict_change_load_and_cleanup() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
        let source = format!("sha256:{}", "a".repeat(64));
        let other = format!("sha256:{}", "b".repeat(64));
        for (expected, current, loaded, list_fails, load_fails, success) in [
            (None, "", source.as_str(), false, false, true),
            (
                Some(other.as_str()),
                other.as_str(),
                source.as_str(),
                false,
                false,
                true,
            ),
            (
                Some(source.as_str()),
                source.as_str(),
                source.as_str(),
                false,
                false,
                true,
            ),
            (None, other.as_str(), source.as_str(), false, false, false),
            (
                Some(other.as_str()),
                source.as_str(),
                source.as_str(),
                false,
                false,
                false,
            ),
            (None, "", other.as_str(), false, false, false),
            (None, "", source.as_str(), true, false, false),
            (None, "", source.as_str(), false, true, false),
        ] {
            let (command, directory, _) = receive_command(request(expected, true), NONCE).unwrap();
            let body = command.args[1]
                .replace(&directory, "'\"$sd_fixture\"'/job")
                .replace("command docker --host unix://$sd_socket", "fake_docker")
                .replace(
                    "run_child docker --host unix://$sd_socket",
                    "run_child fake_docker",
                )
                .replace("while :; do run_child sleep 1 || exit; done", "exit 0");
            let script = format!(
                r#"
sd_fixture=$(mktemp -d /tmp/sd-receive-qa-XXXXXXXX) || exit
mkdir() {{ command mkdir "$@" || return; printf ARCHIVE > "$sd_path"; }}
fake_docker() {{
    case "$1 $2" in
        'image ls') test {list_fails} = false || return 11; if test -n {current}; then printf 'registry:5000/app:v1 %s\n' {current}; fi;;
        'image load') printf called > "$sd_fixture/load-called"; test {load_fails} = false || return 12; test "$(cat "$4")" = ARCHIVE || return 13; printf 'Loaded image: registry:5000/app:v1\n';;
        'image inspect') if test {loaded} = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; then printf 'fixture-content\n'; else printf 'different-content\n'; fi;;
        *) return 14;;
    esac
}}
( {body} )
sd_status=$?
test ! -e "$sd_fixture/job" || exit 7
if test {list_fails} = true || test {current} != {expected}; then
    test ! -e "$sd_fixture/load-called" || exit 8
fi
rm -f -- "$sd_fixture/load-called" || exit 9
rmdir -- "$sd_fixture" || exit 10
exit "$sd_status"
"#,
                current = quote(current).unwrap(),
                expected = quote(expected.unwrap_or("")).unwrap(),
                loaded = quote(loaded).unwrap()
            );
            let mut child = Command::new("wsl")
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
            assert_eq!(
                output.status.success(),
                success,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).contains("SD_ARCHIVE_READY:"),
                success
            );
            assert!(
                !String::from_utf8_lossy(&output.stderr).contains("Archive cleanup incomplete")
            );
        }
    }
}

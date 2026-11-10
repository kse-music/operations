use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    serde_json::{self, Value, json},
};

use crate::docker::PRELUDE;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    RestartExited,
    ClearLogs,
}

// All selection happens on the confirmed SSH host. Never interpolate UI paths or IDs.
const SELECT: &str = r#"
set -f
sd_ok=0; sd_failed=0; sd_skipped=0; sd_matched=0
for sd_id in $sd_ids; do
    case "$sd_id" in *[!a-f0-9]*|'') echo 'Docker returned an invalid container ID' >&2; exit 1;; esac
    test "${#sd_id}" -eq 64 || { echo 'Docker returned an incomplete container ID' >&2; exit 1; }
    sd_matched=$((sd_matched + 1))
done
"#;
const SUMMARY: &str = r#"
printf '{"matched":%s,"succeeded":%s,"failed":%s,"skipped":%s}\n' "$sd_matched" "$sd_ok" "$sd_failed" "$sd_skipped"
"#;
const RESTART: &str = r#"
if test -n "$sd_ids"; then
    sd_output=$(d container restart --time 10 -- $sd_ids)
    sd_status=$?
    for sd_id in $sd_ids; do
        sd_found=0
        for sd_restarted in $sd_output; do
            if test "$sd_restarted" = "$sd_id"; then sd_found=1; break; fi
        done
        if test "$sd_found" -eq 1; then sd_ok=$((sd_ok + 1)); else sd_failed=$((sd_failed + 1)); fi
    done
    if test "$sd_status" -ne 0 && test "$sd_failed" -eq 0; then exit "$sd_status"; fi
fi
"#;
const CLEAR_LOGS: &str = r#"
if test -n "$sd_ids"; then
    command -v truncate >/dev/null 2>&1 || { echo 'Log cleanup requires truncate' >&2; exit 1; }
    sd_root=$(d info --format '{{.DockerRootDir}}') || exit
    sd_root=${sd_root%/}
    case "$sd_root" in /*) ;; *) echo 'Docker data directory is unavailable' >&2; exit 1;; esac
    for sd_id in $sd_ids; do
        sd_driver=$(d container inspect --format '{{.HostConfig.LogConfig.Type}}' -- "$sd_id") || { sd_failed=$((sd_failed + 1)); continue; }
        if test "$sd_driver" != json-file; then
            sd_skipped=$((sd_skipped + 1))
            continue
        fi
        sd_log=$(d container inspect --format '{{.LogPath}}' -- "$sd_id") || { sd_failed=$((sd_failed + 1)); continue; }
        if test "$sd_log" != "$sd_root/containers/$sd_id/$sd_id-json.log" ||
            test -L "$sd_root" || test -L "$sd_root/containers" ||
            test -L "$sd_root/containers/$sd_id" || test -L "$sd_log" || ! test -f "$sd_log"; then
            echo "Refusing unexpected or unavailable log path for container $sd_id" >&2
            sd_failed=$((sd_failed + 1))
        elif truncate --no-create --size 0 -- "$sd_log"; then
            sd_ok=$((sd_ok + 1))
        else
            sd_failed=$((sd_failed + 1))
        fi
    done
fi
"#;

pub fn command(action: &Action) -> String {
    let filter = if matches!(action, Action::RestartExited) {
        " --filter status=exited"
    } else {
        ""
    };
    let operation = if matches!(action, Action::ClearLogs) {
        CLEAR_LOGS
    } else {
        RESTART
    };
    format!(
        "{PRELUDE}sd_ids=$(d container ls --all --quiet --no-trunc{filter}) || exit;{SELECT}{operation}{SUMMARY}"
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    matched: u32,
    succeeded: u32,
    failed: u32,
    skipped: u32,
}

pub fn response(action: &Action, text: &str) -> Result<Value, ApiError> {
    let invalid = || ApiError::new("DOCKER_FORMAT", "容器批量操作结果无效，请刷新核对实际状态");
    let summary: Summary = serde_json::from_str(text).map_err(|_| invalid())?;
    if summary
        .succeeded
        .checked_add(summary.failed)
        .and_then(|total| total.checked_add(summary.skipped))
        != Some(summary.matched)
        || (!matches!(action, Action::ClearLogs) && summary.skipped != 0)
    {
        return Err(invalid());
    }
    let message = if summary.matched == 0 {
        if matches!(action, Action::RestartExited) {
            "没有已退出的容器，无需重启。".into()
        } else {
            "没有容器，无需执行。".into()
        }
    } else {
        format!(
            "{}：匹配 {} 个，成功 {} 个，失败 {} 个，跳过 {} 个。{}",
            if matches!(action, Action::ClearLogs) {
                "清空容器日志"
            } else {
                "重启容器"
            },
            summary.matched,
            summary.succeeded,
            summary.failed,
            summary.skipped,
            if matches!(action, Action::ClearLogs) {
                "仅清理 json-file 当前日志；其他日志驱动跳过，历史轮转文件保留。"
            } else {
                "请核对刷新后的容器状态。"
            }
        )
    };
    Ok(
        json!({"success":summary.failed == 0,"code":if summary.failed == 0 {None} else {Some("DOCKER_PARTIAL_FAILURE")},"message":message,"records":[],"detail":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_empty_partial_and_invalid_results() {
        assert!(
            response(
                &Action::RestartExited,
                r#"{"matched":0,"succeeded":0,"failed":0,"skipped":0}"#
            )
            .unwrap()["message"]
                .as_str()
                .unwrap()
                .contains("没有已退出")
        );
        let partial = response(
            &Action::ClearLogs,
            r#"{"matched":3,"succeeded":1,"failed":1,"skipped":1}"#,
        )
        .unwrap();
        assert_eq!(partial["success"], false);
        assert_eq!(partial["code"], "DOCKER_PARTIAL_FAILURE");
        assert!(partial["message"].as_str().unwrap().contains("失败 1 个"));
        for text in [
            "",
            "{}",
            r#"{"matched":1,"succeeded":0,"failed":0,"skipped":0}"#,
            r#"{"matched":4294967295,"succeeded":4294967295,"failed":1,"skipped":0}"#,
        ] {
            assert!(response(&Action::ClearLogs, text).is_err());
        }
        assert!(
            response(
                &Action::RestartExited,
                r#"{"matched":1,"succeeded":0,"failed":0,"skipped":1}"#
            )
            .is_err()
        );
    }

    // Runs the real command body against a shell fixture, never a Docker daemon.
    #[test]
    #[ignore = "requires local WSL sh, truncate and symlink support; no real Docker access"]
    fn shell_selection_cleanup_and_failures() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        fn run(action: Action, setup: &str, check: &str) -> std::process::Output {
            let script = command(&action);
            let setup = format!(
                "{PRELUDE}\nsd_qa=$(mktemp -d /tmp/serverdeck-maintenance-XXXXXXXX) || exit\ntrap 'case \"$sd_qa\" in /tmp/serverdeck-maintenance-????????) if test -d \"$sd_qa\" && ! test -L \"$sd_qa\"; then rm -rf -- \"$sd_qa\"; fi;; esac' 0\n{setup}\n{}\n{check}",
                script.strip_prefix(PRELUDE).unwrap()
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
                .write_all(setup.as_bytes())
                .unwrap();
            child.wait_with_output().unwrap()
        }
        let ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let restart = format!(
            r#"
d() {{
    case "$1 $2" in
        'container ls') case "$*" in *status=exited*) printf '%s\n' '{a}' '{b}' '{c}';; *) return 9;; esac;;
        'container restart')
            printf '%s\n' "$*" >> "$sd_qa/calls"
            shift 5
            sd_restart_status=0
            for sd_target do
                if test "$sd_target" = '{b}' && test "$sd_qa_fail" -eq 1; then
                    echo "Cannot restart $sd_target" >&2
                    sd_restart_status=1
                else
                    printf '%s\n' "$sd_target"
                fi
            done
            return "$sd_restart_status";;
        *) return 9;;
    esac
}}
"#,
            a = ids[0],
            b = ids[1],
            c = ids[2]
        );
        for failed in [1, 0] {
            let action = Action::RestartExited;
            let out = run(
                action.clone(),
                &format!("sd_qa_fail={failed}\n{restart}"),
                "test -s \"$sd_qa/calls\" || exit 8",
            );
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let result = response(&action, &String::from_utf8(out.stdout).unwrap()).unwrap();
            assert_eq!(result["success"], failed == 0);
            assert!(result["message"].as_str().unwrap().contains("匹配 3 个"));
        }
        for selection in ["return 0", "return 7", "printf '%s\\n' invalid"] {
            let fixture = format!(
                "d() {{ case \"$1 $2\" in 'container ls') {selection};; *) touch \"$sd_qa/unexpected\"; return 9;; esac; }}"
            );
            let out = run(
                Action::RestartExited,
                &fixture,
                "test ! -e \"$sd_qa/unexpected\" || exit 8",
            );
            assert_eq!(out.status.success(), selection == "return 0");
            if out.status.success() {
                assert!(
                    response(
                        &Action::RestartExited,
                        &String::from_utf8(out.stdout).unwrap()
                    )
                    .unwrap()["message"]
                        .as_str()
                        .unwrap()
                        .contains("没有已退出的容器")
                );
            }
        }
        let [a, b, c] = ids;
        let cleanup = format!(
            r#"
sd_data="$sd_qa/data root"
mkdir -p "$sd_data/containers/{a}" "$sd_data/containers/{b}" "$sd_data/containers/{c}"
printf keep > "$sd_qa/outside"
printf clear > "$sd_data/containers/{a}/{a}-json.log"
printf rotated > "$sd_data/containers/{a}/{a}-json.log.1"
ln -s "$sd_qa/outside" "$sd_data/containers/{b}/{b}-json.log"
d() {{
    case "$1 $2" in
        'container ls') printf '%s\n' '{a}' '{b}' '{c}';;
        'info --format') printf '%s\n' "$sd_data";;
        'container inspect')
            case "$6" in
                '{c}') printf '%s\n' local;;
                *) case "$4" in
                    *LogConfig*) printf '%s\n' json-file;;
                    *LogPath*) printf '%s\n' "$sd_data/containers/$6/$6-json.log";;
                    *) return 9;;
                esac;;
            esac;;
        *) return 9;;
    esac
}}
"#
        );
        let checks = format!(
            r#"
test ! -s "$sd_data/containers/{a}/{a}-json.log" &&
test "$(cat "$sd_qa/outside")" = keep &&
test "$(cat "$sd_data/containers/{a}/{a}-json.log.1")" = rotated || exit 8
"#
        );
        let out = run(Action::ClearLogs, &cleanup, &checks);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            summary,
            json!({"matched":3,"succeeded":1,"failed":1,"skipped":1})
        );
        assert!(String::from_utf8_lossy(&out.stderr).contains("Refusing unexpected"));
        // A valid-looking path outside the selected daemon root must never be truncated.
        let unexpected = cleanup.replace("$sd_data/containers/$6/$6-json.log", "$sd_qa/outside");
        let out = run(
            Action::ClearLogs,
            &unexpected,
            "test \"$(cat \"$sd_qa/outside\")\" = keep || exit 8",
        );
        assert!(out.status.success());
        let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(summary["failed"], 2);
        assert_eq!(summary["succeeded"], 0);
        let permission =
            format!("{cleanup}\ntruncate() {{ echo 'Permission denied' >&2; return 1; }}");
        let out = run(Action::ClearLogs, &permission, "");
        assert!(out.status.success());
        let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(summary["failed"], 2);
        assert!(String::from_utf8_lossy(&out.stderr).contains("Permission denied"));
    }
}

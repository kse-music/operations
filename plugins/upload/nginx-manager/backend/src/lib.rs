use serverdeck_plugin_sdk::{
    Capability, CommandResult, FileDocument, Response, SaveResult, host_call, json_error,
    json_reply,
    serde_json::{self, Value, json},
};
use std::collections::BTreeMap;

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    editor: Option<Editor>,
    verified: Option<Verified>,
    log: Option<(String, String)>,
}
struct Pending {
    action: String,
    values: Value,
    host: String,
    hash: String,
    report: BTreeMap<String, Value>,
}
struct Editor {
    host: String,
    document: FileDocument,
}
#[derive(Clone, PartialEq, Eq)]
struct Verified {
    host: String,
    path: String,
    binary: String,
    prefix: String,
    sha256: String,
}
fn field(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}
fn quote(value: &str) -> Result<String, &'static str> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("Command path must be 1..512 bytes without control characters");
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}
fn command(values: &Value, reload: bool) -> Result<String, &'static str> {
    let (binary, path, prefix) = (
        field(values, "binary"),
        field(values, "configPath"),
        field(values, "prefix"),
    );
    if binary != "nginx" && !binary.starts_with('/')
        || !path.starts_with('/')
        || !prefix.is_empty() && !prefix.starts_with('/')
    {
        return Err("Executable/config/prefix must use absolute paths (or executable nginx)");
    }
    let args = format!(
        "{}{} -c {}",
        quote(&binary)?,
        if prefix.is_empty() {
            String::new()
        } else {
            format!(" -p {}", quote(&prefix)?)
        },
        quote(&path)?
    );
    Ok(if reload {
        format!("{args} -t && {args} -s reload")
    } else {
        format!("{args} -t")
    })
}
fn call(id: &str, operation: Capability) -> Value {
    json_reply(host_call(id, operation))
}
fn done(value: Value) -> Value {
    json_reply(json!({"kind":"done","value":value}))
}
fn success(value: &Value) -> bool {
    serde_json::from_value::<CommandResult>(value.clone())
        .is_ok_and(|r| r.state == "completed" && r.exit_code == Some(0))
}
fn argument(output: &str, key: &str) -> Option<String> {
    // nginx -V emits configure arguments. Respect simple quoted values; never execute this text.
    let prefix = format!("--{key}=");
    let rest = output.split(&prefix).nth(1)?;
    let value = if let Some(rest) = rest.strip_prefix('\'') {
        rest.split('\'').next()?
    } else if let Some(rest) = rest.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        rest.split_whitespace().next()?
    };
    (!value.is_empty() && value.starts_with('/')).then(|| value.to_owned())
}
impl State {
    fn start(&mut self, payload: Value) -> Value {
        self.pending = None;
        let action = field(&payload, "action");
        if !["detect", "open", "save", "validate", "reload", "logs"].contains(&action.as_str()) {
            return json_error("ACTION", "Unknown Nginx action");
        }
        let values = payload["values"].clone();
        if !values.is_object() {
            return json_error("UI_VALUES", "Expected form values");
        }
        if (action == "validate" || action == "reload")
            && let Err(e) = command(&values, action == "reload")
        {
            return json_error("PATH", e);
        }
        self.pending = Some(Pending {
            action,
            values,
            host: String::new(),
            hash: String::new(),
            report: BTreeMap::new(),
        });
        call("host", Capability::HostsRead)
    }
    fn resume(&mut self, response: Response) -> Value {
        if let Some(error) = response.error {
            if error.code == "NOT_FOUND"
                && let Some(p) = &self.pending
            {
                if response.request_id == "closed" && p.action == "open" {
                    return call(
                        "opened",
                        Capability::ReadFile {
                            path: field(&p.values, "configPath"),
                        },
                    );
                }
                if response.request_id == "log_closed" && p.action == "logs" {
                    return call(
                        "log_started",
                        Capability::LogStart {
                            path: field(&p.values, "logPath"),
                            lines: 100,
                        },
                    );
                }
            }
            self.pending = None;
            return json_error(&error.code, &error.message);
        }
        let Some(mut p) = self.pending.take() else {
            return json_error("PROTOCOL", "No pending Nginx action");
        };
        let value = response.result;
        let next = match response.request_id.as_str() {
            "host" => {
                p.host = field(&value, "id");
                if p.host.is_empty() {
                    return json_error("HOST", "Host identity missing");
                }
                if self.verified.as_ref().is_some_and(|v| v.host != p.host) {
                    self.verified = None;
                }
                match p.action.as_str() {
                    "detect" => call(
                        "exists",
                        Capability::Execute {
                            command: "command -v nginx".into(),
                            timeout_secs: 10,
                        },
                    ),
                    "open" => {
                        self.verified = None;
                        if let Some(editor) = self.editor.take() {
                            if editor.host == p.host {
                                call(
                                    "closed",
                                    Capability::CloseFile {
                                        document_id: editor.document.id,
                                        discard: true,
                                    },
                                )
                            } else {
                                call(
                                    "opened",
                                    Capability::ReadFile {
                                        path: field(&p.values, "configPath"),
                                    },
                                )
                            }
                        } else {
                            call(
                                "opened",
                                Capability::ReadFile {
                                    path: field(&p.values, "configPath"),
                                },
                            )
                        }
                    }
                    "save" => {
                        self.verified = None;
                        let Some(editor) = &self.editor else {
                            return json_error("DOCUMENT", "Read the configuration before editing");
                        };
                        if editor.host != p.host
                            || editor.document.id != field(&p.values, "documentId")
                            || editor.document.path != field(&p.values, "configPath")
                        {
                            return json_error(
                                "DOCUMENT",
                                "The editor belongs to a different host or file; read it again",
                            );
                        }
                        call(
                            "saved",
                            Capability::SaveFile {
                                document_id: editor.document.id.clone(),
                                content: field(&p.values, "content"),
                            },
                        )
                    }
                    "validate" | "reload" => {
                        if let Some(editor) = &self.editor
                            && editor.host == p.host
                            && editor.document.path == field(&p.values, "configPath")
                            && editor.document.id == field(&p.values, "documentId")
                            && editor.document.content != field(&p.values, "content")
                        {
                            return json_error(
                                "UNSAVED",
                                "Save or discard edits before validating/reloading the disk configuration",
                            );
                        }
                        if p.action == "validate" {
                            self.verified = None;
                        }
                        if p.action == "reload" && self.verified.is_none() {
                            return json_error(
                                "VALIDATION_REQUIRED",
                                "Run a successful nginx -t for this host and configuration first",
                            );
                        }
                        call(
                            "snapshot",
                            Capability::ReadFile {
                                path: field(&p.values, "configPath"),
                            },
                        )
                    }
                    "logs" => {
                        if let Some((host, id)) = self.log.take() {
                            if host == p.host {
                                call("log_closed", Capability::LogStop { log_id: id })
                            } else {
                                call(
                                    "log_started",
                                    Capability::LogStart {
                                        path: field(&p.values, "logPath"),
                                        lines: 100,
                                    },
                                )
                            }
                        } else {
                            call(
                                "log_started",
                                Capability::LogStart {
                                    path: field(&p.values, "logPath"),
                                    lines: 100,
                                },
                            )
                        }
                    }
                    _ => return json_error("ACTION", "Unsupported action"),
                }
            }
            "exists" => {
                if !success(&value) {
                    return done(
                        json!({"values":{"validated":false},"output":{"detected":false,"binaryProbe":value,"message":"Nginx absent from PATH or probe failed; no configuration was modified"}}),
                    );
                }
                let binary = field(&value, "stdout").trim().to_owned();
                if field(&p.values, "binary") == "nginx" || field(&p.values, "binary").is_empty() {
                    p.values["binary"] = json!(binary);
                }
                p.report.insert("binaryProbe".into(), value);
                call(
                    "version",
                    Capability::Execute {
                        command: "nginx -V".into(),
                        timeout_secs: 10,
                    },
                )
            }
            "version" => {
                if success(&value) {
                    let text = format!("{}\n{}", field(&value, "stdout"), field(&value, "stderr"));
                    if field(&p.values, "configPath").is_empty()
                        && let Some(path) = argument(&text, "conf-path")
                    {
                        p.values["configPath"] = json!(path);
                    }
                }
                p.report.insert("version".into(), value);
                call(
                    "service",
                    Capability::Execute {
                        command: "systemctl is-active nginx".into(),
                        timeout_secs: 10,
                    },
                )
            }
            "service" => {
                p.report.insert("serviceStatus".into(), value);
                return done(
                    json!({"values":{"binary":field(&p.values,"binary"),"configPath":field(&p.values,"configPath"),"validated":false},"output":{"detection":p.report,"message":"Service status reports the real systemctl exit/output; containers/non-systemd hosts may return unsupported. Configure custom binary/prefix/path explicitly; no elevation is performed."}}),
                );
            }
            "closed" => call(
                "opened",
                Capability::ReadFile {
                    path: field(&p.values, "configPath"),
                },
            ),
            "opened" => {
                let document: FileDocument = match serde_json::from_value(value) {
                    Ok(d) => d,
                    Err(_) => return json_error("PROTOCOL", "Invalid file response"),
                };
                let result = done(
                    json!({"values":{"documentId":document.id,"configPath":document.path,"content":document.content,"validated":false},"output":{"path":document.path,"sha256":document.sha256,"atomicSave":document.atomic_save,"permissions":document.permissions}}),
                );
                self.editor = Some(Editor {
                    host: p.host,
                    document,
                });
                return result;
            }
            "saved" => {
                let result: SaveResult = match serde_json::from_value(value.clone()) {
                    Ok(v) => v,
                    Err(_) => return json_error("PROTOCOL", "Invalid save response"),
                };
                if result.saved {
                    let Some(document) = result.document else {
                        return json_error("PROTOCOL", "Successful save omitted document");
                    };
                    if let Some(editor) = &mut self.editor {
                        editor.document.content = field(&p.values, "content");
                        editor.document.sha256 = document.sha256;
                    }
                    return done(json!({"values":{"validated":false},"saved":true,"output":value}));
                }
                return done(json!({"values":{"validated":false},"saved":false,"output":value}));
            }
            "snapshot" => {
                let snapshot: FileDocument = match serde_json::from_value(value) {
                    Ok(d) => d,
                    Err(_) => return json_error("PROTOCOL", "Invalid snapshot response"),
                };
                p.hash = snapshot.sha256;
                call(
                    "snapshot_closed",
                    Capability::CloseFile {
                        document_id: snapshot.id,
                        discard: false,
                    },
                )
            }
            "snapshot_closed" => {
                let candidate = Verified {
                    host: p.host.clone(),
                    path: field(&p.values, "configPath"),
                    binary: field(&p.values, "binary"),
                    prefix: field(&p.values, "prefix"),
                    sha256: p.hash.clone(),
                };
                if p.action == "reload" && self.verified.as_ref() != Some(&candidate) {
                    self.verified = None;
                    return done(
                        json!({"values":{"validated":false},"output":{"error":"Configuration, host or command options changed since validation; run nginx -t again"}}),
                    );
                }
                let command = match command(&p.values, p.action == "reload") {
                    Ok(c) => c,
                    Err(e) => return json_error("PATH", e),
                };
                call(
                    "executed",
                    Capability::Execute {
                        command,
                        timeout_secs: 20,
                    },
                )
            }
            "executed" => {
                let ok = success(&value);
                self.verified = if ok {
                    Some(Verified {
                        host: p.host,
                        path: field(&p.values, "configPath"),
                        binary: field(&p.values, "binary"),
                        prefix: field(&p.values, "prefix"),
                        sha256: p.hash,
                    })
                } else {
                    None
                };
                return done(
                    json!({"values":{"validated":ok},"output":{"action":p.action,"success":ok,"commandResult":value,"message":if ok{"Command completed with exit 0; inspect stdout/stderr"}else{"Command failed, timed out or was cancelled. Reload is not approved by this result."}}}),
                );
            }
            "log_closed" => call(
                "log_started",
                Capability::LogStart {
                    path: field(&p.values, "logPath"),
                    lines: 100,
                },
            ),
            "log_started" => {
                let id = field(&value, "id");
                self.log = Some((p.host, id.clone()));
                return done(
                    json!({"values":{"logId":id},"output":{"message":"Log stream started. Pause, search and stop use the bounded Host log API."}}),
                );
            }
            _ => return json_error("PROTOCOL", "Unexpected Host response correlation"),
        };
        self.pending = Some(p);
        next
    }
}
thread_local! {static STATE:std::cell::RefCell<State>=std::cell::RefCell::new(State::default());}
fn handle(op: i32, payload: Value) -> Value {
    match op {
        6 => STATE.with_borrow_mut(|s| s.start(payload)),
        7 => match serde_json::from_value::<Response>(payload["hostResponse"].clone()) {
            Ok(r) => STATE.with_borrow_mut(|s| s.resume(r)),
            Err(_) => json_error("PROTOCOL", "Invalid Host response"),
        },
        2 | 4 | 5 => {
            STATE.with_borrow_mut(|s| *s = State::default());
            json_reply(json!({"state":"stopped"}))
        }
        _ => json_reply(json!({"name":"Nginx Manager","apiVersion":1})),
    }
}
serverdeck_plugin_sdk::export_plugin!(handle);

#[cfg(test)]
mod tests {
    use super::*;
    fn values() -> Value {
        json!({"binary":"/usr/sbin/nginx","configPath":"/tmp/nginx/nginx.conf","prefix":"/tmp/nginx/","content":"events {}","documentId":"editor"})
    }
    fn response(id: &str, result: Value) -> Response {
        Response {
            request_id: id.into(),
            result,
            error: None,
        }
    }
    fn result(code: u32) -> Value {
        json!({"state":"completed","exitCode":code,"stdout":"","stderr":if code==0{"syntax ok"}else{"invalid directive"},"truncated":false,"message":null})
    }
    fn snapshot(hash: &str) -> Value {
        json!({"id":"snapshot","path":"/tmp/nginx/nginx.conf","content":"events {}","sha256":hash,"atomicSave":true,"permissions":420})
    }
    fn validation(state: &mut State, code: u32) {
        state.start(json!({"action":"validate","values":values()}));
        state.resume(response("host", json!({"id":"host-a"})));
        state.resume(response("snapshot", snapshot("hash-a")));
        state.resume(response("snapshot_closed", Value::Null));
        let r = state.resume(response("executed", result(code)));
        assert_eq!(r["result"]["value"]["values"]["validated"], code == 0);
    }
    #[test]
    fn quotes_all_paths_and_never_accepts_relative_or_control_arguments() {
        let mut v = values();
        v["configPath"] = json!("/tmp/$(touch x)'a.conf");
        assert_eq!(
            command(&v, false).unwrap(),
            "'/usr/sbin/nginx' -p '/tmp/nginx/' -c '/tmp/$(touch x)'\"'\"'a.conf' -t"
        );
        v["binary"] = json!("sudo nginx");
        assert!(command(&v, false).is_err());
        v["binary"] = json!("/bin/nginx\nsh");
        assert!(command(&v, true).is_err());
        assert!(
            argument(
                "--conf-path='/etc/nginx path/nginx.conf' --user=nginx",
                "conf-path"
            )
            .is_some()
        );
    }
    #[test]
    fn failed_validation_cannot_enable_reload_and_exit_details_are_real() {
        let mut s = State::default();
        validation(&mut s, 1);
        assert!(s.verified.is_none());
        s.start(json!({"action":"reload","values":values()}));
        let r = s.resume(response("host", json!({"id":"host-a"})));
        assert_eq!(r["error"]["code"], "VALIDATION_REQUIRED");
    }
    #[test]
    fn reload_is_bound_to_host_hash_and_options_and_runs_fresh_test() {
        let mut s = State::default();
        validation(&mut s, 0);
        s.start(json!({"action":"reload","values":values()}));
        s.resume(response("host", json!({"id":"host-a"})));
        s.resume(response("snapshot", snapshot("changed")));
        let r = s.resume(response("snapshot_closed", Value::Null));
        assert_eq!(r["result"]["value"]["values"]["validated"], false);
        assert!(s.verified.is_none());
        validation(&mut s, 0);
        s.start(json!({"action":"reload","values":values()}));
        s.resume(response("host", json!({"id":"host-a"})));
        s.resume(response("snapshot", snapshot("hash-a")));
        let r = s.resume(response("snapshot_closed", Value::Null));
        let c = r["result"]["request"]["operation"]["command"]
            .as_str()
            .unwrap();
        assert!(c.contains(" -t && ") && c.ends_with(" -s reload"));
        s.start(json!({"action":"reload","values":values()}));
        let r = s.resume(response("host", json!({"id":"host-b"})));
        assert_eq!(r["error"]["code"], "VALIDATION_REQUIRED");
    }
    #[test]
    fn unknown_actions_and_fake_resume_are_rejected() {
        let mut s = State::default();
        assert_eq!(
            s.start(json!({"action":"credential_read","values":{}}))["error"]["code"],
            "ACTION"
        );
        assert_eq!(
            s.resume(response("executed", result(0)))["error"]["code"],
            "PROTOCOL"
        );
    }
    #[test]
    fn absent_binary_and_permission_errors_are_not_success() {
        let mut s = State::default();
        s.start(json!({"action":"detect","values":values()}));
        s.resume(response("host", json!({"id":"host-a"})));
        let r = s.resume(response("exists", result(127)));
        assert_eq!(r["result"]["value"]["output"]["detected"], false);
        assert_eq!(
            r["result"]["value"]["output"]["binaryProbe"]["exitCode"],
            127
        );
        s.start(json!({"action":"open","values":values()}));
        let r = s.resume(Response {
            request_id: "host".into(),
            result: Value::Null,
            error: Some(serverdeck_plugin_sdk::ApiError {
                code: "PLUGIN_PERMISSION_DENIED".into(),
                message: "Denied".into(),
            }),
        });
        assert_eq!(r["error"]["code"], "PLUGIN_PERMISSION_DENIED");
        assert!(s.pending.is_none());
    }
    #[test]
    fn failed_save_preserves_editor_and_unsaved_edits_cannot_validate() {
        let mut s = State::default();
        s.start(json!({"action":"open","values":values()}));
        s.resume(response("host", json!({"id":"host-a"})));
        s.resume(response("opened", snapshot("hash-a")));
        let mut v = values();
        v["documentId"] = json!("snapshot");
        v["content"] = json!("edited content");
        s.start(json!({"action":"validate","values":v}));
        assert_eq!(
            s.resume(response("host", json!({"id":"host-a"})))["error"]["code"],
            "UNSAVED"
        );
        s.start(json!({"action":"save","values":v}));
        s.resume(response("host", json!({"id":"host-a"})));
        let r=s.resume(response("saved",json!({"saved":false,"document":null,"recoveryPath":"/tmp/restore","message":"Atomic replacement failed"})));
        assert_eq!(r["result"]["value"]["saved"], false);
        assert_eq!(
            r["result"]["value"]["output"]["recoveryPath"],
            "/tmp/restore"
        );
        assert_eq!(s.editor.unwrap().document.content, "events {}");
    }
}

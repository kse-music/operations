use serde::{Deserialize, Serialize};
type Error = String;
pub fn quote(value: &str) -> Result<String, Error> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err("参数为空、过长或包含 NUL".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}
pub fn container_id(value: &str) -> Result<(), Error> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("请选择完整 64 位容器 ID".into());
    }
    Ok(())
}
fn absolute(value: &str) -> Result<(), Error> {
    if !value.starts_with('/') || value.split('/').any(|part| part == "." || part == "..") {
        return Err("需要不含 . 或 .. 的绝对路径".into());
    }
    quote(value)?;
    Ok(())
}
pub const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceTarget {
    Host,
    Container { id: String },
}
impl ServiceTarget {
    fn prefix(&self) -> Result<String, Error> {
        Ok(match self {
            Self::Host => String::new(),
            Self::Container { id } => {
                container_id(id)?;
                format!("d exec {} ", quote(id)?)
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NginxAction {
    Info,
    Test,
    Reload,
}

pub fn nginx_command(
    target: &ServiceTarget,
    config: &str,
    action: NginxAction,
) -> Result<String, Error> {
    absolute(config)?;
    let prefix = target.prefix()?;
    let config = quote(config)?;
    Ok(match action {
        NginxAction::Info => format!("{prefix}nginx -V 2>&1"),
        NginxAction::Test => format!("{prefix}nginx -t -c {config} 2>&1"),
        // Recheck on the exact frozen target immediately before sending the reload signal.
        NginxAction::Reload => {
            format!("{prefix}nginx -t -c {config} && {prefix}nginx -s reload -c {config}")
        }
    })
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    #[test]
    fn validates_target_and_escapes_shell_metacharacters() {
        assert!(
            ServiceTarget::Container {
                id: "nginx; false".into()
            }
            .prefix()
            .is_err()
        );
        assert!(absolute("/etc/../secret").is_err());
        assert_eq!(quote("a'$(touch BAD)").unwrap(), "'a'\"'\"'$(touch BAD)'");
        assert!(absolute("relative").is_err());
        assert!(quote("a\0b").is_err());
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn reload_retests_the_same_quoted_container_and_configuration() {
        let target = ServiceTarget::Container { id: "a".repeat(64) };
        let command = nginx_command(
            &target,
            "/etc/nginx/a'$(touch BAD).conf",
            NginxAction::Reload,
        )
        .unwrap();
        assert_eq!(command.matches("d exec").count(), 2);
        assert!(command.contains("nginx -t -c"));
        assert!(command.contains("&& d exec"));
        assert!(command.contains("'\"'\"'"));
        assert!(
            nginx_command(
                &ServiceTarget::Host,
                "/etc/../nginx.conf",
                NginxAction::Reload
            )
            .is_err()
        );
    }
}

pub fn log_command(target: &ServiceTarget, path: &str) -> Result<String, Error> {
    let body = match target {
        ServiceTarget::Container { id } => {
            container_id(id)?;
            format!("d logs --timestamps --tail 200 --follow {}", quote(id)?)
        }
        ServiceTarget::Host => {
            absolute(path)?;
            let path = quote(path)?;
            format!("test -f {path} && test -r {path} || exit 77; exec tail -n 200 -F -- {path}")
        }
    };
    Ok(format!("{PRELUDE}{body}"))
}

use serverdeck_plugin_sdk::{
    ApiError,
    backend::Context,
    platform::{Command, Request},
    serde_json::{self, Map, Value, json},
};

use crate::{compose, docker};

// Environment values use the existing, separate opt-in query. The fixed snapshot
// returns names only and is selected by full container ID inside the plugin.
pub const FORMAT: &str = r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Image":{{json (index .Config "Image")}},"Cmd":{{json (index .Config "Cmd")}},"Entrypoint":{{json (index .Config "Entrypoint")}},"WorkingDir":{{json (index .Config "WorkingDir")}},"User":{{json (index .Config "User")}},"Hostname":{{json (index .Config "Hostname")}},"Domainname":{{json (index .Config "Domainname")}},"Labels":{{json (index .Config "Labels")}},"ExposedPorts":{{json (index .Config "ExposedPorts")}},"Healthcheck":{{json (index .Config "Healthcheck")}},"StopSignal":{{json (index .Config "StopSignal")}},"StopTimeout":{{json (index .Config "StopTimeout")}},"Tty":{{json (index .Config "Tty")}},"OpenStdin":{{json (index .Config "OpenStdin")}}},"EnvironmentKeys":[{{range $i,$e := (index .Config "Env")}}{{if $i}},{{end}}{{json (index (split $e "=") 0)}}{{end}}],"HostConfig":{{json .HostConfig}},"Mounts":{{json (index . "Mounts")}},"NetworkSettings":{"Ports":{{json (index .NetworkSettings "Ports")}},"Networks":{{json (index .NetworkSettings "Networks")}}}}"#;

pub fn snapshot_command() -> Result<String, ApiError> {
    Ok(format!(
        "{}{}",
        docker::PRELUDE,
        docker::inspect_command(FORMAT)?
    ))
}

pub fn compose_command(reveal: bool) -> Command {
    Command::script(format!(
        "{}\nsd_reveal={}\n{}",
        docker::PRELUDE,
        reveal,
        include_str!("compose-config.sh").replace("\r\n", "\n")
    ))
}

pub fn select_configuration(
    stdout: &str,
    stderr: &str,
    selected: &Value,
    project: &str,
) -> Result<(Value, bool, Vec<String>), ApiError> {
    let mut found = None;
    for (index, item) in serde_json::Deserializer::from_str(stdout)
        .into_iter::<Value>()
        .enumerate()
    {
        if index >= 10000 {
            return Err(invalid("Compose 配置快照超过项目数量限制"));
        }
        let row = item.map_err(|_| invalid("Compose 配置快照格式无效"))?;
        if !row.is_object() {
            return Err(invalid("Compose 配置快照格式无效"));
        }
        if row["Project"].as_str() != Some(project) {
            continue;
        }
        if found.is_some() {
            return Err(invalid("Compose 配置快照包含重复项目"));
        }
        if !row["Members"]
            .as_array()
            .is_some_and(|ids| ids.contains(&selected["Id"]))
        {
            return Err(invalid("容器已不在该 Compose 项目中，请刷新后重试"));
        }
        let labels = &selected["Config"]["Labels"];
        if row["WorkingDir"] != labels["com.docker.compose.project.working_dir"]
            || row["ConfigFiles"] != labels["com.docker.compose.project.config_files"]
        {
            return Err(invalid("Compose 项目目录或配置文件已变化，请刷新后重试"));
        }
        let id = row["Id"]
            .as_str()
            .ok_or_else(|| invalid("Compose 快照缺少容器标识"))?;
        docker::container_id(id)?;
        let begin = format!("SERVERDECK_COMPOSE_BEGIN {id}");
        let end = format!("SERVERDECK_COMPOSE_END {id}");
        let diagnostic = stderr
            .lines()
            .skip_while(|line| *line != begin)
            .skip(1)
            .take_while(|line| *line != end)
            .collect::<Vec<_>>()
            .join("\n");
        match row["ExitCode"].as_u64() {
            Some(0) => {}
            Some(_) => {
                return Err(ApiError::new(
                    "COMPOSE_CONFIG",
                    if diagnostic.is_empty() {
                        "当前项目配置读取失败，可使用容器信息转换。".into()
                    } else {
                        diagnostic
                    },
                ));
            }
            None => return Err(invalid("Compose 配置快照缺少执行结果")),
        }
        if !row["Model"].is_object() {
            return Err(invalid("Compose 配置输出格式无效"));
        }
        let resolved = row["EnvironmentFilesResolved"]
            .as_bool()
            .ok_or_else(|| invalid("Compose 配置快照缺少环境解析状态"))?;
        found = Some((
            row["Model"].clone(),
            resolved,
            if diagnostic.is_empty() {
                vec![]
            } else {
                vec![diagnostic]
            },
        ));
    }
    found.ok_or_else(|| invalid("当前 Compose 项目已不存在或缺少有效标签，请刷新后重试"))
}

fn invalid(message: &str) -> ApiError {
    ApiError::new("DOCKER_CONFIG", message)
}

pub fn select(text: &str, id: &str) -> Result<Value, ApiError> {
    docker::container_id(id)?;
    let mut selected = None;
    for (index, line) in text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        if index >= 10000 {
            return Err(invalid("启动配置快照超过容器数量限制"));
        }
        let value: Value =
            serde_json::from_str(line).map_err(|_| invalid("启动配置快照格式无效"))?;
        if !value.is_object() {
            return Err(invalid("启动配置快照格式无效"));
        }
        if value["Id"].as_str() == Some(id) {
            if selected.is_some() {
                return Err(invalid("启动配置快照包含重复容器"));
            }
            selected = Some(value);
        }
    }
    selected.ok_or_else(|| ApiError::new("DOCKER_NOT_FOUND", "容器已不存在，请刷新列表"))
}

fn entries(value: &Value) -> impl Iterator<Item = (&String, &Value)> {
    value.as_object().into_iter().flatten()
}

fn active(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_i64() != Some(0),
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}

fn copy(out: &mut Map<String, Value>, from: &Value, pairs: &[(&str, &str)]) {
    for (source, target) in pairs {
        if active(&from[*source]) {
            out.insert((*target).into(), from[*source].clone());
        }
    }
}

fn environment(service: &mut Value, reveal: bool) {
    if reveal {
        return;
    }
    if let Some(values) = service.get_mut("environment") {
        if let Some(map) = values.as_object_mut() {
            for value in map.values_mut() {
                *value = json!("[已隐藏]");
            }
        } else if let Some(list) = values.as_array_mut() {
            for value in list {
                if let Some(name) = value.as_str().map(|v| v.split('=').next().unwrap_or(v)) {
                    *value = json!(format!("{name}=[已隐藏]"));
                }
            }
        }
    }
}

// Keep the whole service object, rather than enumerating a subset of Compose keys.
pub fn from_compose(model: &Value, service: &str, reveal: bool) -> Result<Value, ApiError> {
    let mut selected = model["services"][service]
        .as_object()
        .cloned()
        .map(Value::Object)
        .ok_or_else(|| invalid("当前 Compose 文件中已找不到该 service"))?;
    environment(&mut selected, reveal);
    let mut result = json!({"services":{service:selected}});
    for section in ["networks", "volumes", "configs", "secrets"] {
        let mut definitions = Map::new();
        let references = &result["services"][service][section];
        let names: Vec<&str> = if section == "networks" && references.is_object() {
            entries(references).map(|(name, _)| name.as_str()).collect()
        } else {
            references
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    if section == "networks" {
                        item.as_str()
                    } else {
                        item.as_str().or_else(|| item["source"].as_str())
                    }
                })
                .collect()
        };
        for name in names {
            if let Some(definition) = model[section].get(name) {
                let mut definition = definition.clone();
                // Inline secret/config content is not needed to describe its reference.
                if let Some(map) = definition.as_object_mut()
                    && map.contains_key("content")
                {
                    map.insert("content".into(), json!("[内容已隐藏]"));
                }
                definitions.insert(name.into(), definition);
            }
        }
        if !definitions.is_empty() {
            result[section] = Value::Object(definitions);
        }
    }
    Ok(result)
}

pub fn from_inspect(v: &Value, env: Option<&Value>) -> Result<(Value, Vec<String>), ApiError> {
    let config = &v["Config"];
    let host = &v["HostConfig"];
    if !config.is_object() || !host.is_object() || !config["Image"].is_string() {
        return Err(invalid("容器启动配置不完整"));
    }
    let name = v["Name"].as_str().unwrap_or("").trim_start_matches('/');
    let mut service = Map::new();
    let mut warnings = vec![
        "根据容器当前信息转换，无法还原原始 docker run 命令、参数来源或创建后已改变的设置。".into(),
    ];
    copy(
        &mut service,
        config,
        &[
            ("Image", "image"),
            ("Cmd", "command"),
            ("Entrypoint", "entrypoint"),
            ("WorkingDir", "working_dir"),
            ("User", "user"),
            ("Domainname", "domainname"),
            ("StopSignal", "stop_signal"),
            ("Tty", "tty"),
            ("OpenStdin", "stdin_open"),
        ],
    );
    for (source, target) in [("Cmd", "command"), ("Entrypoint", "entrypoint")] {
        if config[source].is_array() {
            service.insert(target.into(), config[source].clone());
        }
    }
    if host["MemorySwappiness"].is_number() {
        service.insert("mem_swappiness".into(), host["MemorySwappiness"].clone());
    }
    if !name.is_empty() {
        service.insert("container_name".into(), json!(name));
    }
    if let Some(hostname) = config["Hostname"].as_str().filter(|s| !s.is_empty())
        && !v["Id"]
            .as_str()
            .is_some_and(|id| id.get(..12) == Some(hostname))
    {
        service.insert("hostname".into(), json!(hostname));
    }
    let labels: Map<String, Value> = entries(&config["Labels"])
        .filter(|(key, _)| !key.starts_with("com.docker.compose."))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !labels.is_empty() {
        service.insert("labels".into(), Value::Object(labels));
    }
    let mut variables = Map::new();
    if let Some(values) = env.and_then(Value::as_array) {
        for item in values {
            if let Some(item) = item.as_str() {
                let (key, value) = item
                    .split_once('=')
                    .map_or((item, Value::Null), |(k, v)| (k, json!(v)));
                variables.insert(key.into(), value);
            }
        }
    } else {
        for key in v["EnvironmentKeys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            variables.insert(key.into(), json!("[已隐藏]"));
        }
    }
    if !variables.is_empty() {
        service.insert("environment".into(), Value::Object(variables));
    }
    let policy = &host["RestartPolicy"];
    if let Some(policy_name) = policy["Name"].as_str().filter(|s| !s.is_empty()) {
        let count = policy["MaximumRetryCount"].as_u64().unwrap_or(0);
        service.insert(
            "restart".into(),
            json!(if policy_name == "on-failure" && count > 0 {
                format!("on-failure:{count}")
            } else {
                policy_name.into()
            }),
        );
    }
    if let Some(timeout) = config["StopTimeout"].as_u64() {
        service.insert("stop_grace_period".into(), json!(format!("{timeout}s")));
    }
    copy(
        &mut service,
        host,
        &[
            ("Privileged", "privileged"),
            ("ReadonlyRootfs", "read_only"),
            ("Init", "init"),
            ("CapAdd", "cap_add"),
            ("CapDrop", "cap_drop"),
            ("SecurityOpt", "security_opt"),
            ("Dns", "dns"),
            ("DnsSearch", "dns_search"),
            ("DnsOptions", "dns_opt"),
            ("ExtraHosts", "extra_hosts"),
            ("GroupAdd", "group_add"),
            ("Sysctls", "sysctls"),
            ("Memory", "mem_limit"),
            ("MemoryReservation", "mem_reservation"),
            ("MemorySwap", "memswap_limit"),
            ("MemorySwappiness", "mem_swappiness"),
            ("CpuShares", "cpu_shares"),
            ("CpuPeriod", "cpu_period"),
            ("CpuQuota", "cpu_quota"),
            ("CpusetCpus", "cpuset"),
            ("PidsLimit", "pids_limit"),
            ("ShmSize", "shm_size"),
            ("OomKillDisable", "oom_kill_disable"),
            ("OomScoreAdj", "oom_score_adj"),
            ("PidMode", "pid"),
            ("UTSMode", "uts"),
            ("CgroupParent", "cgroup_parent"),
            ("CgroupnsMode", "cgroup"),
            ("Runtime", "runtime"),
            ("StorageOpt", "storage_opt"),
        ],
    );
    if host["IpcMode"]
        .as_str()
        .is_some_and(|mode| mode != "private" && !mode.is_empty())
    {
        service.insert("ipc".into(), host["IpcMode"].clone());
    }
    if let Some(cpus) = host["NanoCpus"].as_u64().filter(|n| *n > 0) {
        service.insert(
            "cpus".into(),
            json!(
                format!("{}.{:09}", cpus / 1_000_000_000, cpus % 1_000_000_000)
                    .trim_end_matches('0')
                    .trim_end_matches('.')
            ),
        );
    }
    if let Some(driver) = host["LogConfig"]["Type"].as_str().filter(|s| !s.is_empty()) {
        service.insert("logging".into(), json!({"driver":driver,"options":host["LogConfig"]["Config"].as_object().cloned().unwrap_or_default()}));
    }
    let health = &config["Healthcheck"];
    if health.is_object() {
        let mut check = Map::new();
        copy(
            &mut check,
            health,
            &[("Test", "test"), ("Retries", "retries")],
        );
        for (source, target) in [
            ("Interval", "interval"),
            ("Timeout", "timeout"),
            ("StartPeriod", "start_period"),
            ("StartInterval", "start_interval"),
        ] {
            if let Some(ns) = health[source].as_u64().filter(|n| *n > 0) {
                check.insert(target.into(), json!(format!("{ns}ns")));
            }
        }
        service.insert("healthcheck".into(), Value::Object(check));
    }
    let devices: Vec<Value> = host["Devices"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            json!(format!(
                "{}:{}:{}",
                d["PathOnHost"].as_str().unwrap_or(""),
                d["PathInContainer"].as_str().unwrap_or(""),
                d["CgroupPermissions"].as_str().unwrap_or("rwm")
            ))
        })
        .collect();
    if !devices.is_empty() {
        service.insert("devices".into(), json!(devices));
    }
    let limits: Map<String, Value> = host["Ulimits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            Some((
                l["Name"].as_str()?.into(),
                json!({"soft":l["Soft"],"hard":l["Hard"]}),
            ))
        })
        .collect();
    if !limits.is_empty() {
        service.insert("ulimits".into(), Value::Object(limits));
    }
    let mut ports = Vec::new();
    let mut bindings: Map<String, Value> = entries(&host["PortBindings"])
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (key, actual) in entries(&v["NetworkSettings"]["Ports"]) {
        if actual.as_array().is_some_and(|v| !v.is_empty()) {
            bindings.insert(key.clone(), actual.clone());
        }
    }
    for (key, values) in &bindings {
        let (port, protocol) = key.split_once('/').unwrap_or((key, "tcp"));
        let target: u16 = port.parse().map_err(|_| invalid("容器端口格式无效"))?;
        for binding in values.as_array().into_iter().flatten() {
            let mut mapping = json!({"target":target,"protocol":protocol});
            if binding["HostPort"].as_str().is_some_and(|p| !p.is_empty()) {
                mapping["published"] = binding["HostPort"].clone();
            }
            if binding["HostIp"].as_str().is_some_and(|ip| !ip.is_empty()) {
                mapping["host_ip"] = binding["HostIp"].clone();
            }
            ports.push(mapping);
        }
    }
    if !ports.is_empty() {
        service.insert("ports".into(), json!(ports));
    }
    let exposed: Vec<&String> = entries(&config["ExposedPorts"])
        .map(|(key, _)| key)
        .collect();
    if !exposed.is_empty() {
        service.insert("expose".into(), json!(exposed));
    }
    let mut volumes = Map::new();
    let mut mounts = Vec::new();
    for mount in v["Mounts"].as_array().into_iter().flatten() {
        let kind = mount["Type"]
            .as_str()
            .ok_or_else(|| invalid("挂载类型缺失"))?;
        if kind == "tmpfs"
            && mount["Destination"]
                .as_str()
                .is_some_and(|target| host["Tmpfs"].get(target).is_some())
        {
            continue;
        }
        let mut item =
            json!({"type":kind,"target":mount["Destination"],"read_only":mount["RW"] == false});
        match kind {
            "volume" => {
                let name = mount["Name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid("数据卷名称缺失"))?;
                let key = format!("volume_{}", volumes.len() + 1);
                volumes.insert(key.clone(), json!({"external":true,"name":name}));
                item["source"] = json!(key);
            }
            "bind" | "npipe" => {
                item["source"] = mount["Source"].clone();
            }
            "tmpfs" => {}
            _ => {
                warnings.push(format!("挂载类型 {kind} 无法可靠转换，已跳过。"));
                continue;
            }
        }
        if kind == "bind" && mount["Propagation"].as_str().is_some_and(|p| !p.is_empty()) {
            item["bind"] = json!({"propagation":mount["Propagation"]});
        }
        if let Some(original) = host["Mounts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["Target"] == mount["Destination"])
        {
            if original["VolumeOptions"]["NoCopy"] == true {
                item["volume"] = json!({"nocopy":true});
            }
            for (option, key) in [
                ("VolumeOptions", "Subpath"),
                ("BindOptions", "NonRecursive"),
                ("BindOptions", "ReadOnlyNonRecursive"),
                ("BindOptions", "ReadOnlyForceRecursive"),
            ] {
                if active(&original[option][key]) {
                    warnings.push(format!("挂载选项 {option}.{key} 尚未转换。"));
                }
            }
            if let Some(options) = original["TmpfsOptions"].as_object() {
                let mut tmpfs = Map::new();
                copy(
                    &mut tmpfs,
                    &Value::Object(options.clone()),
                    &[("SizeBytes", "size"), ("Mode", "mode")],
                );
                if !tmpfs.is_empty() {
                    item["tmpfs"] = Value::Object(tmpfs);
                }
            }
        }
        if kind == "volume"
            && mount["Mode"]
                .as_str()
                .is_some_and(|mode| mode.split(',').any(|part| part == "nocopy"))
        {
            item["volume"] = json!({"nocopy":true});
        }
        if kind == "bind"
            && mount["Mode"]
                .as_str()
                .is_some_and(|m| m.split(',').any(|s| s == "z" || s == "Z"))
        {
            let selinux = mount["Mode"]
                .as_str()
                .unwrap_or("")
                .split(',')
                .find(|s| *s == "z" || *s == "Z");
            if item["bind"].is_null() {
                item["bind"] = json!({});
            }
            item["bind"]["selinux"] = json!(selinux);
        }
        mounts.push(item);
    }
    if !mounts.is_empty() {
        service.insert("volumes".into(), json!(mounts));
    }
    if active(&host["Tmpfs"]) {
        service.insert(
            "tmpfs".into(),
            json!(
                entries(&host["Tmpfs"])
                    .map(|(path, options)| format!("{path}:{}", options.as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
            ),
        );
    }
    let mut networks = Map::new();
    let mode = host["NetworkMode"].as_str().unwrap_or("default");
    if matches!(mode, "host" | "none" | "bridge" | "default") || mode.starts_with("container:") {
        service.insert(
            "network_mode".into(),
            json!(if mode == "default" { "bridge" } else { mode }),
        );
    } else {
        let mut attached = Map::new();
        for (name, options) in entries(&v["NetworkSettings"]["Networks"]) {
            let key = format!("network_{}", networks.len() + 1);
            networks.insert(key.clone(), json!({"external":true,"name":name}));
            let mut attachment = Map::new();
            copy(
                &mut attachment,
                options,
                &[("Aliases", "aliases"), ("DriverOpts", "driver_opts")],
            );
            copy(
                &mut attachment,
                &options["IPAMConfig"],
                &[
                    ("IPv4Address", "ipv4_address"),
                    ("IPv6Address", "ipv6_address"),
                    ("LinkLocalIPs", "link_local_ips"),
                ],
            );
            attached.insert(key, Value::Object(attachment));
        }
        if attached.is_empty() {
            warnings.push(format!("网络模式 {mode} 缺少网络详情，未生成 networks。"));
        } else {
            service.insert("networks".into(), Value::Object(attached));
        }
    }
    // Active options without a mapping must be visible as a limitation, never
    // copied under invented Compose keys or silently represented as complete.
    let mapped = [
        "Binds",
        "Mounts",
        "Tmpfs",
        "PortBindings",
        "NetworkMode",
        "RestartPolicy",
        "LogConfig",
        "Privileged",
        "ReadonlyRootfs",
        "Init",
        "CapAdd",
        "CapDrop",
        "SecurityOpt",
        "Dns",
        "DnsSearch",
        "DnsOptions",
        "ExtraHosts",
        "GroupAdd",
        "Sysctls",
        "Memory",
        "MemoryReservation",
        "MemorySwap",
        "MemorySwappiness",
        "CpuShares",
        "CpuPeriod",
        "CpuQuota",
        "CpusetCpus",
        "PidsLimit",
        "ShmSize",
        "OomKillDisable",
        "OomScoreAdj",
        "PidMode",
        "UTSMode",
        "CgroupParent",
        "CgroupnsMode",
        "Runtime",
        "StorageOpt",
        "IpcMode",
        "NanoCpus",
        "Devices",
        "Ulimits",
        "ConsoleSize",
    ];
    let unsupported: Vec<&str> = entries(host)
        .filter(|(k, v)| {
            !mapped.contains(&k.as_str())
                && active(v)
                && !(k.as_str() == "Isolation" && v.as_str() == Some("default"))
        })
        .map(|(k, _)| k.as_str())
        .collect();
    if !unsupported.is_empty() {
        warnings.push(format!(
            "以下 Docker 设置尚未转换：{}。",
            unsupported.join("、")
        ));
    }
    warnings.push(
        "生成结果用于查看；外部卷/网络、依赖容器及主机路径需要原环境，不保证可独立部署。".into(),
    );
    let mut result = json!({"services":{"container":service}});
    if !volumes.is_empty() {
        result["volumes"] = Value::Object(volumes);
    }
    if !networks.is_empty() {
        result["networks"] = Value::Object(networks);
    }
    Ok((result, warnings))
}

pub async fn load(
    context: &Context,
    host: &str,
    id: &str,
    reveal: bool,
    inspect_only: bool,
) -> Result<Value, ApiError> {
    docker::container_id(id)?;
    let bound = context
        .request(Request::Host {
            host_id: host.into(),
        })
        .await?;
    let binding = bound["binding"]
        .as_str()
        .ok_or_else(|| invalid("无法绑定当前 SSH 主机配置"))?;
    let context = context.with_bindings(vec![binding.into()]);
    let snapshot = context
        .execute(host, Command::script(snapshot_command()?))
        .await?
        .checked()?;
    let selected = select(&snapshot.stdout, id)?;
    let labels = &selected["Config"]["Labels"];
    let project = labels["com.docker.compose.project"].as_str();
    let service = labels["com.docker.compose.service"].as_str();
    let mut diagnostics = Vec::new();
    let (model, source, mut warnings) = if !inspect_only && (project.is_some() || service.is_some())
    {
        let project = project.ok_or_else(|| invalid("Compose 项目标记缺失，可改用容器信息转换"))?;
        let service = service
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("Compose service 标记缺失，可改用容器信息转换"))?;
        let rows = vec![
            json!({"WorkingDir":labels["com.docker.compose.project.working_dir"],"ConfigFiles":labels["com.docker.compose.project.config_files"]}),
        ];
        compose::project_name(project)?;
        compose::target(&rows)?;
        let output = context
            .execute(host, compose_command(reveal))
            .await?
            .checked()?;
        let (model, resolved, diagnostics) =
            select_configuration(&output.stdout, &output.stderr, &selected, project)?;
        let mut warnings = vec!["展示当前项目文件中的 service 配置，可能与容器创建时不同；其他 service 仅保留依赖引用。".into(), if reveal {"环境变量按当前项目环境解析，不代表容器创建时的值。".into()} else if resolved {"当前 Compose 版本会解析 env_file，返回界面前已隐藏环境变量值；变量表达式保持引用。".into()} else {"环境变量值已隐藏；变量表达式及 env_file 引用保留，尚未解析环境文件。".into()}];
        warnings.extend(diagnostics);
        (from_compose(&model, service, reveal)?, "compose", warnings)
    } else {
        let env = if reveal {
            let query = docker::Query::ContainerDetails {
                id: id.into(),
                reveal_env: true,
            };
            let output = context
                .execute(host, Command::script(query.command()?))
                .await?
                .checked()?;
            if !output.stderr.is_empty() {
                diagnostics.push(output.stderr.clone());
            }
            Some(query.response(&output.stdout)?["detail"]["environment"].clone())
        } else {
            None
        };
        let (model, warnings) = from_inspect(&selected, env.as_ref())?;
        (model, "inspect", warnings)
    };
    if !snapshot.stderr.is_empty() {
        warnings.push(snapshot.stderr);
    }
    warnings.extend(diagnostics);
    Ok(
        json!({"success":true,"code":null,"message":null,"records":[],"detail":{"id":id,"source":source,"project":project,"service":service,"configuration":model,"environmentRevealed":reveal,"warnings":warnings}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compose_container(directory: &str) -> Value {
        json!({"Id":"a".repeat(64),"Config":{"Labels":{"com.docker.compose.project":"shop","com.docker.compose.project.working_dir":directory,"com.docker.compose.project.config_files":format!("{directory}/compose.yaml,{directory}/override.yaml")}}})
    }

    fn config_record(selected: &Value) -> Value {
        json!({"Id":selected["Id"],"Members":[selected["Id"]],"Project":"shop","WorkingDir":selected["Config"]["Labels"]["com.docker.compose.project.working_dir"],"ConfigFiles":selected["Config"]["Labels"]["com.docker.compose.project.config_files"],"ExitCode":0,"EnvironmentFilesResolved":false,"Model":{"services":{"web":{"image":"nginx"}}}})
    }

    #[test]
    fn configuration_snapshots_isolate_errors_and_revalidate_identity() {
        let selected = compose_container("/srv/my app");
        let good = config_record(&selected);
        let other = json!({"Project":"other","ExitCode":2,"Model":null});
        let stderr = format!(
            "SERVERDECK_COMPOSE_BEGIN {}\nselected warning\nSERVERDECK_COMPOSE_END {}\nSERVERDECK_COMPOSE_BEGIN {}\nunrelated failure\nSERVERDECK_COMPOSE_END {}",
            "a".repeat(64),
            "a".repeat(64),
            "b".repeat(64),
            "b".repeat(64)
        );
        let stream = format!(
            "{}\n{}",
            other,
            serde_json::to_string_pretty(&good).unwrap()
        );
        let (model, resolved, diagnostic) =
            select_configuration(&stream, &stderr, &selected, "shop").unwrap();
        assert_eq!(model["services"]["web"]["image"], "nginx");
        assert!(!resolved);
        assert_eq!(diagnostic, vec!["selected warning"]);
        assert!(select_configuration(&format!("{good}\n{good}"), "", &selected, "shop").is_err());
        assert!(select_configuration("broken", "", &selected, "shop").is_err());
        assert!(select_configuration("[]", "", &selected, "shop").is_err());
        assert!(select_configuration("", "", &selected, "shop").is_err());
        for (field, value) in [
            ("WorkingDir", json!("/other")),
            ("ConfigFiles", json!("/other.yaml")),
            ("Members", json!(["b".repeat(64)])),
            ("EnvironmentFilesResolved", Value::Null),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(select_configuration(&bad.to_string(), "", &selected, "shop").is_err());
        }
        let mut failed = good;
        failed["ExitCode"] = json!(1);
        failed["Model"] = Value::Null;
        let error =
            select_configuration(&failed.to_string(), &stderr, &selected, "shop").unwrap_err();
        assert_eq!(error.code, "COMPOSE_CONFIG");
        assert_eq!(error.message, "selected warning");
    }

    fn run_sh(script: &str) -> std::process::Output {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };
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
            .write_all(format!("{script}\n").as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn fixture(directory: &str, modern: bool, conflict: bool, live: bool) -> String {
        let selected = compose_container(directory);
        let mut metadata = config_record(&selected);
        for key in ["Members", "Model", "ExitCode", "EnvironmentFilesResolved"] {
            metadata.as_object_mut().unwrap().remove(key);
        }
        let mut other = metadata.clone();
        other["Id"] = json!("c".repeat(64));
        other["Project"] = json!("other");
        let vars=[("sd_qa_a","a".repeat(64)),("sd_qa_b","b".repeat(64)),("sd_qa_c","c".repeat(64)),("sd_qa_dir",directory.into()),("sd_qa_file1",format!("{directory}/compose.yaml")),("sd_qa_file2",format!("{directory}/override.yaml")),("sd_qa_files",format!("{directory}/compose.yaml,{directory}/override.yaml")),("sd_qa_modern",modern.to_string()),("sd_qa_conflict",conflict.to_string()),("sd_qa_live",live.to_string()),("sd_qa_model",json!({"services":{"web":{"image":"nginx","environment":{"TOKEN":"fixture-secret"}}}}).to_string()),("sd_qa_shop_meta",metadata.to_string()),("sd_qa_other_meta",other.to_string()),("sd_qa_identity",format!("{} {}",json!(directory),selected["Config"]["Labels"]["com.docker.compose.project.config_files"]))];
        let mut setup = String::new();
        for (key, value) in vars {
            setup.push_str(&format!(
                "{key}={}\n",
                serverdeck_plugin_sdk::platform::quote(&value).unwrap()
            ));
        }
        setup.push_str(&include_str!("compose-config-fixture.sh").replace("\r\n", "\n"));
        setup
    }

    #[test]
    #[ignore = "requires local WSL sh; all Docker operations use an isolated shell fixture"]
    fn shell_config_handles_legacy_flags_paths_and_project_failures() {
        let directory = "/srv/my app'$(not-a-command)/中文";
        let selected = compose_container(directory);
        for (modern, reveal) in [(true, false), (false, false), (false, true), (true, true)] {
            let command = compose_command(reveal);
            let body = command.args[1].strip_prefix(docker::PRELUDE).unwrap();
            let output = run_sh(&format!(
                "{}\n{}\n{body}",
                docker::PRELUDE,
                fixture(directory, modern, false, false)
            ));
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let (model, resolved, diagnostic) = select_configuration(
                &String::from_utf8(output.stdout).unwrap(),
                &String::from_utf8(output.stderr).unwrap(),
                &selected,
                "shop",
            )
            .unwrap();
            assert_eq!(resolved, reveal || !modern);
            assert_eq!(model["services"]["web"]["image"], "nginx");
            assert!(diagnostic.is_empty());
            assert!(
                !from_compose(&model, "web", false)
                    .unwrap()
                    .to_string()
                    .contains("fixture-secret")
            );
        }
        for directory in ["relative", "/srv/bad\npath"] {
            let command = compose_command(false);
            let output = run_sh(&format!(
                "{}\n{}\n{}",
                docker::PRELUDE,
                fixture(directory, true, false, false),
                command.args[1].strip_prefix(docker::PRELUDE).unwrap()
            ));
            let error = select_configuration(
                &String::from_utf8(output.stdout).unwrap(),
                &String::from_utf8(output.stderr).unwrap(),
                &compose_container(directory),
                "shop",
            )
            .unwrap_err();
            assert_eq!(error.code, "COMPOSE_CONFIG");
        }
        let command = compose_command(false);
        let output = run_sh(&format!(
            "{}\n{}\n{}",
            docker::PRELUDE,
            fixture("/srv/app", true, true, false),
            command.args[1].strip_prefix(docker::PRELUDE).unwrap()
        ));
        assert!(
            select_configuration(
                &String::from_utf8(output.stdout).unwrap(),
                &String::from_utf8(output.stderr).unwrap(),
                &compose_container("/srv/app"),
                "shop"
            )
            .unwrap_err()
            .message
            .contains("不一致")
        );
    }

    fn container() -> Value {
        json!({"Id":"a".repeat(64),"Name":"/web","EnvironmentKeys":["TOKEN","EMPTY"],
            "Config":{"Image":"nginx:alpine","Cmd":["nginx","-g","daemon off;"],"Entrypoint":["/entrypoint"],"ExposedPorts":{"80/tcp":{},"53/udp":{}},"Labels":{"com.docker.compose.project":"old","custom":"value"},"Healthcheck":{"Test":["CMD","true"],"Interval":1000000000}},
            "HostConfig":{"NetworkMode":"custom","PortBindings":{"80/tcp":[{"HostIp":"::1","HostPort":"8080"}]},"RestartPolicy":{"Name":"on-failure","MaximumRetryCount":3},"Memory":134217728,"NanoCpus":1500000000,"Tmpfs":{"/cache":"rw,size=16m"},"AutoRemove":true,"Mounts":[{"Target":"/data","VolumeOptions":{"NoCopy":true}}]},
            "Mounts":[{"Type":"bind","Source":"/srv/a b","Destination":"/html","RW":false,"Mode":"ro,Z","Propagation":"rprivate"},{"Type":"volume","Name":"existing-data","Destination":"/data","RW":true},{"Type":"tmpfs","Destination":"/cache","RW":true}],
            "NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"::1","HostPort":"8080"}]},"Networks":{"custom":{"Aliases":["web"],"IPAddress":"172.20.0.2","IPAMConfig":null}}}})
    }

    #[test]
    fn inspect_preserves_ports_mounts_commands_and_external_resources() {
        let (model, warnings) = from_inspect(&container(), None).unwrap();
        let service = &model["services"]["container"];
        assert_eq!(
            service["ports"],
            json!([{"target":80,"protocol":"tcp","published":"8080","host_ip":"::1"}])
        );
        assert_eq!(service["expose"], json!(["53/udp", "80/tcp"]));
        assert_eq!(service["volumes"].as_array().unwrap().len(), 2);
        assert_eq!(service["volumes"][0]["read_only"], true);
        assert_eq!(service["volumes"][0]["bind"]["selinux"], "Z");
        assert_eq!(service["volumes"][1]["volume"]["nocopy"], true);
        assert_eq!(
            model["volumes"]["volume_1"],
            json!({"external":true,"name":"existing-data"})
        );
        assert_eq!(service["tmpfs"], json!(["/cache:rw,size=16m"]));
        assert_eq!(model["networks"]["network_1"]["name"], "custom");
        assert!(
            service["networks"]["network_1"]
                .get("ipv4_address")
                .is_none()
        );
        assert_eq!(service["command"], json!(["nginx", "-g", "daemon off;"]));
        assert_eq!(service["restart"], "on-failure:3");
        assert_eq!(service["healthcheck"]["interval"], "1000000000ns");
        assert_eq!(service["cpus"], "1.5");
        assert_eq!(service["mem_limit"], 134217728);
        assert_eq!(service["environment"]["TOKEN"], "[已隐藏]");
        assert!(
            service["labels"]
                .get("com.docker.compose.project")
                .is_none()
        );
        assert!(warnings.iter().any(|w| w.contains("AutoRemove")));
        let (revealed, _) =
            from_inspect(&container(), Some(&json!(["TOKEN=a=b", "EMPTY="]))).unwrap();
        assert_eq!(
            revealed["services"]["container"]["environment"],
            json!({"TOKEN":"a=b","EMPTY":""})
        );
        let mut legacy_mount = container();
        legacy_mount["HostConfig"]["Mounts"] = json!([]);
        legacy_mount["Mounts"][1]["Mode"] = json!("nocopy");
        let (legacy, _) = from_inspect(&legacy_mount, None).unwrap();
        assert_eq!(
            legacy["services"]["container"]["volumes"][1]["volume"]["nocopy"],
            true
        );
    }

    #[test]
    fn stopped_containers_keep_requested_ports_and_host_network_is_not_replaced() {
        let mut v = container();
        v["NetworkSettings"]["Ports"] = Value::Null;
        v["HostConfig"]["NetworkMode"] = json!("host");
        let (model, _) = from_inspect(&v, None).unwrap();
        assert_eq!(
            model["services"]["container"]["ports"][0]["published"],
            "8080"
        );
        assert_eq!(model["services"]["container"]["network_mode"], "host");
        assert!(model.get("networks").is_none());
        v["HostConfig"]["PortBindings"] = json!({"bad/tcp":[{}]});
        assert!(from_inspect(&v, None).is_err());
        assert!(from_inspect(&json!({}), None).is_err());
    }

    #[test]
    fn compose_keeps_complete_service_but_isolates_dependencies_and_secret_content() {
        let model = json!({"services":{"web":{"image":"nginx","build":{"context":"/src"},"depends_on":{"db":{"condition":"service_healthy"}},"environment":{"TOKEN":"private","EMPTY":""},"networks":{"front":{}},"volumes":[{"type":"volume","source":"data","target":"/data"}],"secrets":[{"source":"key"}],"configs":["settings"],"x-custom":{"keep":true}},"db":{"image":"db","environment":{"OTHER":"other-private"}}},"networks":{"front":{"external":true},"unused":{}},"volumes":{"data":{}},"secrets":{"key":{"content":"secret-content"}},"configs":{"settings":{"content":"config-content"}}});
        let selected = from_compose(&model, "web", false).unwrap();
        assert_eq!(selected["services"].as_object().unwrap().len(), 1);
        assert_eq!(
            selected["services"]["web"]["build"],
            model["services"]["web"]["build"]
        );
        assert_eq!(
            selected["services"]["web"]["x-custom"],
            json!({"keep":true})
        );
        assert!(selected["networks"].get("unused").is_none());
        assert_eq!(selected["secrets"]["key"]["content"], "[内容已隐藏]");
        for secret in [
            "private",
            "other-private",
            "secret-content",
            "config-content",
        ] {
            assert!(!selected.to_string().contains(secret));
        }
        assert_eq!(
            from_compose(&model, "web", true).unwrap()["services"]["web"]["environment"]["TOKEN"],
            "private"
        );
        assert!(from_compose(&model, "gone", false).is_err());
    }

    #[test]
    fn snapshot_is_selected_by_full_id_and_does_not_output_environment_values() {
        let id = "a".repeat(64);
        assert_eq!(
            select(
                &format!("{}\n{}", json!({"Id":"b".repeat(64)}), container()),
                &id
            )
            .unwrap()["Name"],
            "/web"
        );
        assert!(select("[]", &id).is_err());
        assert!(select("bad", &id).is_err());
        assert!(select("", &id).is_err());
        assert!(select(&container().to_string(), "short").is_err());
        let duplicate = format!("{}\n{}", container(), container());
        assert!(select(&duplicate, &id).is_err());
        assert!(!FORMAT.contains("json .Config.Env"));
        assert!(!FORMAT.contains("json .Config}}"));
    }

    #[test]
    #[ignore = "requires local WSL Docker/Compose; reads daemon and isolated config files only"]
    fn live_read_only_snapshot_and_compose_config() {
        use std::{
            io::Write,
            process::{Command as Process, Stdio},
        };
        let run = |script: &str| {
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
                .write_all(format!("{script}\n").as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "read-only command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        };
        let snapshot = run(&snapshot_command().unwrap());
        assert!(
            !snapshot.trim().is_empty(),
            "read-only format test needs an existing local container"
        );
        let absent_env = FORMAT.replace(
            "(index .Config \"Env\")",
            "(index .Config \"ServerDeck_QA_Absent_Env\")",
        );
        let absent_snapshot = run(&format!(
            "{}{}",
            docker::PRELUDE,
            docker::inspect_command(&absent_env).unwrap()
        ));
        for line in absent_snapshot.lines().filter(|s| !s.is_empty()) {
            let row: Value = serde_json::from_str(line).unwrap();
            assert_eq!(row["EnvironmentKeys"], json!([]));
        }
        for line in snapshot.lines().filter(|s| !s.is_empty()) {
            let row: Value = serde_json::from_str(line).unwrap();
            assert!(row["Config"].get("Env").is_none());
            let (converted, _) = from_inspect(&row, None).unwrap();
            assert_eq!(
                converted["services"]["container"]["image"],
                row["Config"]["Image"]
            );
        }
        let folder = std::env::current_dir()
            .unwrap()
            .join(".local/qa/docker-startup/live-config");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("compose.yaml"), b"services:\n  web:\n    image: nginx:alpine\n    ports:\n      - '${HTTP_PORT:-8080}:80'\n    volumes:\n      - data:/data\n    env_file: missing.env\n    environment:\n      TOKEN: fixture-private\n    depends_on: [db]\n  db:\n    image: postgres:alpine\nvolumes:\n  data: {}\n").unwrap();
        std::fs::write(folder.join("override.yaml"), b"services:\n  web:\n    restart: unless-stopped\n    labels:\n      test.override: applied\n").unwrap();
        let folder = folder.to_str().unwrap().replace('\\', "/");
        let folder = format!("/mnt/{}/{}", folder[..1].to_ascii_lowercase(), &folder[3..]);
        let help = run(&format!("{}d compose config --help", docker::PRELUDE));
        let modern = help.contains("--no-env-resolution");
        if !modern {
            std::fs::write(
                std::env::current_dir()
                    .unwrap()
                    .join(".local/qa/docker-startup/live-config/missing.env"),
                b"FROM_ENV_FILE=fixture-env-private\n",
            )
            .unwrap();
        }
        let command = compose_command(false);
        let output = run_sh(&format!(
            "{}\n{}\n{}",
            docker::PRELUDE,
            fixture(&folder, modern, false, true),
            command.args[1].strip_prefix(docker::PRELUDE).unwrap()
        ));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (model, resolved, _) = select_configuration(
            &String::from_utf8(output.stdout).unwrap(),
            &String::from_utf8(output.stderr).unwrap(),
            &compose_container(&folder),
            "shop",
        )
        .unwrap();
        assert_eq!(resolved, !modern);
        let selected = from_compose(&model, "web", false).unwrap();
        assert_eq!(selected["services"]["web"]["restart"], "unless-stopped");
        assert_eq!(
            selected["services"]["web"]["labels"]["test.override"],
            "applied"
        );
        assert!(selected["volumes"]["data"].is_object());
        assert!(selected["services"].get("db").is_none());
        assert!(!selected.to_string().contains("fixture-private"));
    }
}

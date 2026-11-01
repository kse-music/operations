use serde_json::{Value, json};
use serverdeck_core::{
    Error,
    ops::{Request, Response},
};
use std::collections::BTreeMap;
fn invalid() -> Error {
    Error::Connection {
        code: "OPS_FORMAT",
        message: "远端输出格式不兼容，未伪造操作结果",
        source: None,
    }
}
fn json_lines(text: &str) -> Result<Vec<Value>, Error> {
    let mut records = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        if records.len() >= 10000 {
            return Err(invalid());
        }
        records.push(serde_json::from_str(line).map_err(|e| Error::Connection {
            code: "OPS_FORMAT",
            message: "远端 JSON 格式不兼容",
            source: Some(Box::new(e)),
        })?);
    }
    Ok(records)
}
pub fn response(request: &Request, bytes: &[u8]) -> Result<Response, Error> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    Ok(match request {
        Request::Capabilities => {
            let p = text.split('\0').collect::<Vec<_>>();
            if p.len() != 9 || p[0] != "SDOPS1" {
                return Err(invalid());
            }
            let version: Option<Value> = serde_json::from_str(p[2].trim()).ok();
            Response::detail(
                json!({"dockerInstalled":p[1]=="1","dockerState":if p[1]!="1"{"absent"}else if p[3]=="0"{"running"}else{"unavailable"},"dockerVersion":version,"systemd":p[4]=="1","processes":p[5]=="1","ports":p[6]=="1","python":p[7]=="1"}),
            )
        }
        Request::Containers | Request::Images | Request::ContainerStats { .. } => {
            Response::records(json_lines(text)?)
        }
        Request::ContainerDetails { reveal_env, .. } => {
            let mut v: Value = serde_json::from_str(text.trim()).map_err(|_| invalid())?;
            let config = &v["Config"];
            let env = config["Env"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| {
                            let text = value.as_str().unwrap_or("");
                            if *reveal_env {
                                text.to_owned()
                            } else {
                                format!(
                                    "{}=••••••",
                                    text.split_once('=').map(|(name, _)| name).unwrap_or(text)
                                )
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            v = json!({"id":v["Id"],"name":v["Name"],"image":config["Image"],"created":v["Created"],"state":v["State"],"environment":env,"environmentRevealed":reveal_env,"ports":v["NetworkSettings"]["Ports"],"mounts":v["Mounts"],"restartPolicy":v["HostConfig"]["RestartPolicy"]});
            Response::detail(v)
        }
        Request::Processes => {
            let mut rows = Vec::new();
            for line in text.lines() {
                let fields = line.split_whitespace().collect::<Vec<_>>();
                if fields.len() < 6 || rows.len() >= 10000 {
                    return Err(invalid());
                }
                let pid = fields[0].parse::<u32>().map_err(|_| invalid())?;
                let cpu = fields[2].parse::<f64>().map_err(|_| invalid())?;
                let memory = fields[3].parse::<f64>().map_err(|_| invalid())?;
                if !cpu.is_finite() || !memory.is_finite() {
                    return Err(invalid());
                }
                rows.push(json!({"pid":pid,"user":fields[1],"cpu":cpu,"memory":memory,"elapsed":fields[4],"command":fields[5..].join(" ")}));
            }
            Response::records(rows)
        }
        Request::ProcessDetails { pid } => {
            let p = text.split('\0').collect::<Vec<_>>();
            if p.len() != 5 || p[0] != "SDPROC1" {
                return Err(invalid());
            }
            let stat = p[2].trim();
            let end = stat.rfind(')').ok_or_else(invalid)?;
            let fields = stat[end + 1..].split_whitespace().collect::<Vec<_>>();
            let start = fields
                .get(19)
                .filter(|v| v.parse::<u64>().is_ok())
                .ok_or_else(invalid)?;
            let status = p[3]
                .lines()
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k, v.trim()))
                .collect::<BTreeMap<_, _>>();
            Response::detail(
                json!({"pid":pid,"startTicks":start,"bootId":p[1].trim(),"executable":p[4].trim(),"status":status}),
            )
        }
        Request::Ports => {
            let mut rows = Vec::new();
            for line in text.lines() {
                let f = line.split_whitespace().collect::<Vec<_>>();
                if f.len() < 6 || rows.len() >= 10000 {
                    return Err(invalid());
                }
                let process = (f.len() > 6).then(|| f[6..].join(" "));
                rows.push(json!({"protocol":f[0],"state":f[1],"local":f[4],"peer":f[5],"process":process}));
            }
            Response::records(rows)
        }
        Request::Services { .. } => {
            let (loaded, files) = text.split_once('\0').ok_or_else(invalid)?;
            let mut rows = BTreeMap::<String, Value>::new();
            for line in loaded.lines() {
                let f = line.split_whitespace().collect::<Vec<_>>();
                if f.len() < 4 {
                    return Err(invalid());
                }
                rows.insert(f[0].into(),json!({"unit":f[0],"load":f[1],"active":f[2],"sub":f[3],"description":f[4..].join(" "),"enabled":null}));
            }
            for line in files.lines() {
                let f = line.split_whitespace().collect::<Vec<_>>();
                if f.len() < 2 {
                    return Err(invalid());
                }
                rows.entry(f[0].into()).or_insert_with(
                    || json!({"unit":f[0],"load":null,"active":null,"sub":null,"description":null}),
                )["enabled"] = json!(f[1]);
            }
            if rows.len() > 10000 {
                return Err(invalid());
            }
            Response::records(rows.into_values().collect())
        }
        Request::ServiceDetails { .. } => Response::detail(json!(
            text.lines()
                .filter_map(|l| l.split_once('='))
                .collect::<BTreeMap<_, _>>()
        )),
        Request::Probe { .. } => {
            Response::detail(serde_json::from_str(text.trim()).map_err(|_| invalid())?)
        }
        _ => Response {
            message: Some("请求已完成，请刷新目标状态核对".into()),
            ..Response::records(vec![])
        },
    })
}

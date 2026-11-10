use crate::{Error, agent::AgentHost, ops::*};
use serde::{
    Deserialize, Serialize,
    de::{DeserializeOwned, Error as _},
};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolId {
    Diagnostic,
    Capabilities,
    Images,
    Containers,
    ContainerDetails,
    ContainerStats,
    Processes,
    ProcessDetails,
    Ports,
    Services,
    ServiceDetails,
    RemoveUntaggedImages,
    Container,
    Service,
    FileRead,
    FileEdit,
    TransferPrepare,
    Transfer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Read,
    Change,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub id: ToolId,
    pub label: &'static str,
    pub effect: Effect,
    pub permission: &'static str,
    pub input_schema: Value,
}

impl ToolId {
    pub fn label(self) -> &'static str {
        match self {
            Self::Diagnostic => "主机资源",
            Self::Capabilities => "主机能力",
            Self::Images => "Docker 镜像",
            Self::Containers => "Docker 容器",
            Self::ContainerDetails => "容器详情",
            Self::ContainerStats => "容器资源",
            Self::Processes | Self::ProcessDetails => "主机进程",
            Self::Ports => "监听端口",
            Self::Services => "systemd 服务",
            Self::ServiceDetails => "服务详情",
            Self::RemoveUntaggedImages => "清理全部无标签镜像",
            Self::Container => "容器操作",
            Self::Service => "服务操作",
            Self::FileRead => "读取文件",
            Self::FileEdit => "修改文件",
            Self::TransferPrepare => "准备文件传输",
            Self::Transfer => "传输文件",
        }
    }
}

pub fn catalog() -> Vec<Definition> {
    use ToolId::*;
    let id = json!({"type":"string","pattern":"^[0-9a-fA-F]{64}$"});
    let scope = json!({"type":"string","enum":["system","user"]});
    let unit = json!({"type":"string","minLength":8,"maxLength":256,"pattern":"^(?!-)[a-zA-Z0-9_.@:\\\\-]*\\.service$"});
    let text = json!({"type":"string","minLength":1,"maxLength":4096});
    let host = json!({"type":"string","minLength":1,"maxLength":128});
    let endpoint = json!({"type":"object","properties":{"hostId":host,"path":text},"required":["hostId","path"],"additionalProperties":false});
    let source = json!({"oneOf":[{"type":"object","properties":{"kind":{"const":"local"},"path":text},"required":["kind","path"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"remote"},"hostId":host,"path":text},"required":["kind","hostId","path"],"additionalProperties":false}]});
    [
        (Diagnostic, Effect::Read, json!({"tool":{"enum":["uptime","memory","disk"]}})),
        (Capabilities, Effect::Read, json!({})),
        (Images, Effect::Read, json!({})),
        (Containers, Effect::Read, json!({})),
        (ContainerDetails, Effect::Read, json!({"id":id,"revealEnv":{"const":false},"confirmed":{"const":false}})),
        (ContainerStats, Effect::Read, json!({"id":id})),
        (Processes, Effect::Read, json!({})),
        (ProcessDetails, Effect::Read, json!({"pid":{"type":"integer","minimum":2,"maximum":2147483647}})),
        (Ports, Effect::Read, json!({})),
        (Services, Effect::Read, json!({"scope":scope})),
        (ServiceDetails, Effect::Read, json!({"scope":scope,"unit":unit})),
        (RemoveUntaggedImages, Effect::Change, json!({})),
        (Container, Effect::Change, json!({"id":id,"action":{"enum":["start","stop","restart","remove"]}})),
        (Service, Effect::Change, json!({"scope":scope,"unit":unit,"action":{"enum":["start","stop","restart","enable","disable"]}})),
        (FileRead,Effect::Read,json!({"hostId":host,"path":text,"startLine":{"type":"integer","minimum":1},"lines":{"type":"integer","minimum":1,"maximum":200}})),
        (FileEdit,Effect::Change,json!({"documentId":host,"edits":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"startLine":{"type":"integer","minimum":1},"deleteLines":{"type":"integer","minimum":0},"insertLines":{"type":"array","maxItems":200,"items":{"type":"string"}}},"required":["startLine","deleteLines","insertLines"],"additionalProperties":false}}})),
        (TransferPrepare,Effect::Read,json!({"source":source,"destination":endpoint,"overwrite":{"type":"boolean"}})),
        (Transfer,Effect::Change,json!({"previewId":host})),
    ].into_iter().map(|(id, effect, mut properties)| {
        properties["kind"] = json!({"const":id});
        let required = properties.as_object().into_iter().flat_map(|p| p.keys()).cloned().collect::<Vec<_>>();
        Definition { id, label: id.label(), effect, permission: match id {FileRead=>"sftp.read",FileEdit=>"sftp.write",TransferPrepare|Transfer=>"sftp.transfer",_=>"ssh.execute"}, input_schema: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}) }
    }).collect()
}

pub trait Arguments {
    const EFFECT: Effect;
    fn validate(&self) -> Result<(), Error>;
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Query {
    Files(crate::files::Query),
    Operations(Request),
}
impl Query {
    pub fn tool(&self) -> Result<ToolId, Error> {
        match self {
            Self::Operations(request) => query_id(request),
            Self::Files(crate::files::Query::FileRead { .. }) => Ok(ToolId::FileRead),
            Self::Files(crate::files::Query::TransferPrepare { .. }) => Ok(ToolId::TransferPrepare),
        }
    }
}
impl Arguments for Query {
    const EFFECT: Effect = Effect::Read;
    fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Operations(request) => validate_query(request).map(|_| ()),
            Self::Files(query) => query.validate(),
        }
    }
}

pub struct Call<T>(pub T);
thread_local! {
    static DEFINITIONS: Vec<Definition> = catalog();
}
fn validate_shape(value: &Value, effect: Effect) -> Result<(), &'static str> {
    DEFINITIONS.with(|definitions| {
        let definition = definitions
            .iter()
            .find(|d| json!(d.id) == value["kind"] && d.effect == effect)
            .ok_or("未开放的工具或读写类型错误")?;
        let properties = definition.input_schema["properties"]
            .as_object()
            .ok_or("工具目录无效")?;
        let object = value.as_object().ok_or("工具参数必须为对象")?;
        // Internally tagged unit variants otherwise accept extra fields in serde.
        if object.len() != properties.len()
            || object.keys().any(|key| !properties.contains_key(key))
        {
            return Err("工具参数缺失或包含未声明字段");
        }
        Ok(())
    })
}
impl<'de, T: DeserializeOwned + Arguments> Deserialize<'de> for Call<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        validate_shape(&value, T::EFFECT).map_err(D::Error::custom)?;
        let arguments: T = serde_json::from_value(value).map_err(D::Error::custom)?;
        arguments
            .validate()
            .map_err(|e| D::Error::custom(e.message()))?;
        Ok(Self(arguments))
    }
}
impl Arguments for Request {
    const EFFECT: Effect = Effect::Read;
    fn validate(&self) -> Result<(), Error> {
        validate_query(self).map(|_| ())
    }
}

pub fn query_id(request: &Request) -> Result<ToolId, Error> {
    Ok(match request {
        Request::Diagnostic { .. } => ToolId::Diagnostic,
        Request::Capabilities => ToolId::Capabilities,
        Request::Images => ToolId::Images,
        Request::Containers => ToolId::Containers,
        Request::ContainerDetails {
            reveal_env: false,
            confirmed: false,
            ..
        } => ToolId::ContainerDetails,
        Request::ContainerStats { .. } => ToolId::ContainerStats,
        Request::Processes => ToolId::Processes,
        Request::ProcessDetails { .. } => ToolId::ProcessDetails,
        Request::Ports => ToolId::Ports,
        Request::Services { .. } => ToolId::Services,
        Request::ServiceDetails { .. } => ToolId::ServiceDetails,
        _ => return Err(Error::Validation("智能体请求了未开放的查询工具或权限参数")),
    })
}

pub fn validate_query(request: &Request) -> Result<ToolId, Error> {
    let id = query_id(request)?;
    request.command()?;
    Ok(id)
}

pub async fn query(host: &impl AgentHost, request: Request) -> Result<Response, Error> {
    validate_query(&request)?;
    host.query(request).await
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    RemoveUntaggedImages,
    Container {
        id: String,
        action: ContainerAction,
    },
    Service {
        scope: Scope,
        unit: String,
        action: ServiceAction,
    },
    FileEdit {
        document_id: String,
        edits: Vec<crate::files::Edit>,
    },
    Transfer {
        preview_id: String,
    },
}

impl Action {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::RemoveUntaggedImages => Ok(()),
            Self::Container { id, .. } => container_id(id),
            Self::Service { unit, .. } => unit_name(unit),
            Self::FileEdit { document_id, edits } => {
                reference(document_id)?;
                crate::files::validate_edits(edits)
            }
            Self::Transfer { preview_id } => reference(preview_id),
        }
    }
}
fn reference(id: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        Err(Error::Validation("文件资源引用无效"))
    } else {
        Ok(())
    }
}
impl Arguments for Action {
    const EFFECT: Effect = Effect::Change;
    fn validate(&self) -> Result<(), Error> {
        self.validate()
    }
}

pub fn change_id(request: &Request) -> Result<ToolId, Error> {
    match request {
        Request::ImageRemove {
            confirmed: true, ..
        } => Ok(ToolId::RemoveUntaggedImages),
        Request::ContainerAction {
            confirmed: true, ..
        } => Ok(ToolId::Container),
        Request::ServiceAction {
            confirmed: true, ..
        } => Ok(ToolId::Service),
        _ => Err(Error::Validation("计划包含未开放的变更工具")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Succeeded,
    Verified,
    Failed,
    Unverified,
    Skipped,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool: ToolId,
    pub status: ToolStatus,
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_arguments_and_execution_validation_agree() {
        let cases = [
            json!({"kind":"diagnostic","tool":"uptime"}),
            json!({"kind":"capabilities"}),
            json!({"kind":"images"}),
            json!({"kind":"containers"}),
            json!({"kind":"container_details","id":"a".repeat(64),"revealEnv":false,"confirmed":false}),
            json!({"kind":"container_stats","id":"a".repeat(64)}),
            json!({"kind":"processes"}),
            json!({"kind":"process_details","pid":2}),
            json!({"kind":"ports"}),
            json!({"kind":"services","scope":"system"}),
            json!({"kind":"service_details","scope":"user","unit":"app.service"}),
            json!({"kind":"remove_untagged_images"}),
            json!({"kind":"container","id":"a".repeat(64),"action":"restart"}),
            json!({"kind":"service","scope":"system","unit":"app.service","action":"enable"}),
            json!({"kind":"file_read","hostId":"host","path":"/work/x.yaml","startLine":1,"lines":100}),
            json!({"kind":"file_edit","documentId":"doc","edits":[{"startLine":6,"deleteLines":1,"insertLines":[]}]}),
            json!({"kind":"transfer_prepare","source":{"kind":"local","path":"D:/work/x.tar.gz"},"destination":{"hostId":"test","path":"/work"},"overwrite":false}),
            json!({"kind":"transfer","previewId":"copy"}),
        ];
        let definitions = catalog();
        assert_eq!(cases.len(), definitions.len());
        for (value, definition) in cases.into_iter().zip(definitions) {
            assert_eq!(value["kind"], json!(definition.id));
            if definition.effect == Effect::Read {
                let request = serde_json::from_value::<Call<Query>>(value).unwrap().0;
                assert_eq!(request.tool().unwrap(), definition.id);
            } else {
                serde_json::from_value::<Call<Action>>(value)
                    .unwrap()
                    .0
                    .validate()
                    .unwrap();
            }
            assert_eq!(definition.input_schema["additionalProperties"], false);
        }
    }

    #[test]
    fn rejects_unexposed_tools_and_privilege_or_parameter_injection() {
        for value in [
            json!({"kind":"container_details","id":"a".repeat(64),"revealEnv":true,"confirmed":true}),
            json!({"kind":"container_details","id":"a".repeat(64),"revealEnv":false,"confirmed":true}),
            json!({"kind":"image_remove","id":"a".repeat(64),"confirmed":true}),
            json!({"kind":"process_details","pid":1}),
            json!({"kind":"service_details","scope":"system","unit":"x.service; reboot"}),
            json!({"kind":"container_stats","id":"$(reboot)"}),
        ] {
            let request = serde_json::from_value::<Request>(value).unwrap();
            assert!(validate_query(&request).is_err());
        }
        for value in [
            json!({"kind":"execute","command":"reboot"}),
            json!({"kind":"images","readOnly":true}),
        ] {
            assert!(serde_json::from_value::<Call<Request>>(value).is_err());
        }
        assert!(
            serde_json::from_value::<Call<Action>>(
                json!({"kind":"container","id":"a".repeat(64),"action":"remove","confirmed":true})
            )
            .is_err()
        );
    }
}

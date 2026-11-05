use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentObservation {
    pub query: String,
    pub success: bool,
    pub records: usize,
    pub message: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    pub action: String,
    pub target: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReport {
    pub observations: Vec<AgentObservation>,
    pub steps: Vec<AgentStep>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStepResult {
    pub action: String,
    pub target: String,
    pub status: String,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecution {
    pub steps: Vec<AgentStepResult>,
}

use super::*;
use tokio_util::sync::CancellationToken;

fn image(letter: char, tag: &str) -> Value {
    json!({"ID":format!("sha256:{}",letter.to_string().repeat(64)),"Repository":"fixture","Tag":tag})
}
async fn task(
    rows: Arc<Mutex<Vec<Value>>>,
) -> (
    tempfile::TempDir,
    Application,
    Preview,
    Answer,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    app.secrets = Arc::new(super::super::tests::Store::default());
    app.secrets.write("agent-test-key", b"test-key").unwrap();
    let (config,http)=model_sequence(vec![json!({"kind":"query","requests":[{"kind":"images"}]}).to_string(),json!({"kind":"plan","summary":"删除 tag 为 <none> 的镜像，不强制；确认后执行并复查","actions":[{"kind":"remove_untagged_images"}]}).to_string()]).await;
    let model = app
        .database
        .ai_model_save(
            ModelRecord {
                id: uuid::Uuid::new_v4().to_string(),
                name: "agent protocol model".into(),
                revision: "agent-revision".into(),
                secret_ref: Some("agent-test-key".into()),
                config,
            },
            None,
        )
        .unwrap();
    let (session, _, _, calls, sshd) = ssh_with_images(&app, true, 1, rows).await;
    let preview = app
        .ai_prepare(PrepareInput {
            model_id: model.id,
            session_id: Some(session.id),
            question: "删除 tag 为 <none> 的 Docker 镜像".into(),
            selection: ContextSelection {
                server: false,
                metrics: false,
                processes: false,
                docker: false,
                log: None,
                log_lines: 20,
            },
            mask_addresses: true,
            redact_values: vec![],
            history: vec![],
            session_ids: vec![],
            auto_hosts: false,
            expected_model_revision: None,
        })
        .await
        .unwrap();
    let answer = app
        .ai_agent_send(preview.id.clone(), true, &CancellationToken::new())
        .await
        .unwrap();
    let request = http.await.unwrap();
    assert!(request.to_string().contains("untrustedToolResults"));
    assert!(
        !calls.lock().unwrap().iter().any(|c| c.contains("image rm")),
        "discovery and planning never mutate"
    );
    (dir, app, preview, answer, calls, sshd)
}
fn approval(answer: &Answer) -> ExecuteInput {
    ExecuteInput {
        proposal_id: answer.proposals[0].id.clone(),
        confirmed: true,
        change_confirmation: answer.proposals[0].change_confirmation.clone(),
    }
}

#[tokio::test]
async fn ssh_agent_discovers_freezes_confirms_deletes_exact_images_and_rechecks_every_result() {
    let rows = Arc::new(Mutex::new(vec![
        image('a', "<none>"),
        image('b', "<none>"),
        image('c', "latest"),
    ]));
    let (_dir, app, _preview, answer, calls, sshd) = task(rows.clone()).await;
    assert_eq!(answer.agent.as_ref().unwrap().steps.len(), 2);
    rows.lock().unwrap().push(image('d', "<none>"));
    let mut rejected = approval(&answer);
    rejected.confirmed = false;
    assert!(
        app.ai_agent_execute(rejected, &CancellationToken::new())
            .await
            .is_err()
    );
    let result = app
        .ai_agent_execute(approval(&answer), &CancellationToken::new())
        .await
        .unwrap();
    assert!(result.success);
    assert!(
        result
            .agent
            .unwrap()
            .steps
            .iter()
            .all(|s| s.status == "verified")
    );
    let remaining = rows.lock().unwrap().clone();
    assert_eq!(remaining.len(), 2);
    assert!(remaining.iter().any(|r| r["Tag"] == "latest"));
    assert!(
        remaining
            .iter()
            .any(|r| r["ID"] == image('d', "<none>")["ID"]),
        "newly discovered image must not expand approved plan"
    );
    let before = calls.lock().unwrap().len();
    assert!(
        app.ai_agent_execute(approval(&answer), &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(before, calls.lock().unwrap().len());
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.contains("image rm --no-prune"))
            .count(),
        2
    );
    app.shutdown().await;
    sshd.abort();
}
#[tokio::test]
async fn ssh_agent_retagged_target_invalidates_plan_without_removal_or_following_steps() {
    let rows = Arc::new(Mutex::new(vec![image('a', "<none>"), image('b', "<none>")]));
    let (_dir, app, _preview, answer, calls, sshd) = task(rows.clone()).await;
    rows.lock().unwrap()[0]["Tag"] = json!("keep-new-tag");
    let result = app
        .ai_agent_execute(approval(&answer), &CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.success);
    let results = result.agent.unwrap().steps;
    assert_eq!(results[0].status, "failed");
    assert_eq!(results[1].status, "skipped");
    assert_eq!(rows.lock().unwrap().len(), 2);
    assert!(!calls.lock().unwrap().iter().any(|c| c.contains("image rm")));
    app.shutdown().await;
    sshd.abort();
}
#[tokio::test]
async fn ssh_agent_partial_failure_reports_completed_failed_and_skipped_without_retrying() {
    let mut rejected = image('b', "<none>");
    rejected["rejectDelete"] = json!(true);
    let rows = Arc::new(Mutex::new(vec![
        image('a', "<none>"),
        rejected,
        image('c', "<none>"),
    ]));
    let (_dir, app, _preview, answer, calls, sshd) = task(rows.clone()).await;
    let result = app
        .ai_agent_execute(approval(&answer), &CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.success);
    assert_eq!(
        result
            .agent
            .unwrap()
            .steps
            .iter()
            .map(|s| s.status.as_str())
            .collect::<Vec<_>>(),
        vec!["verified", "failed", "skipped"]
    );
    assert_eq!(rows.lock().unwrap().len(), 2);
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.contains("image rm --no-prune"))
            .count(),
        2
    );
    app.shutdown().await;
    sshd.abort();
}
#[tokio::test]
async fn ssh_agent_cancelled_or_disconnected_plan_never_runs_mutations() {
    for disconnect in [false, true] {
        let rows = Arc::new(Mutex::new(vec![image('a', "<none>")]));
        let (_dir, app, preview, answer, calls, sshd) = task(rows.clone()).await;
        if disconnect {
            let binding = app
                .assistant
                .execution_binding(&answer.proposals[0].id)
                .unwrap();
            app.ops_close(&binding.session.id).await.unwrap();
            let result = app
                .ai_agent_execute(approval(&answer), &CancellationToken::new())
                .await
                .unwrap();
            assert!(!result.success);
            assert_eq!(result.agent.unwrap().steps[0].status, "failed");
        } else {
            app.ai_cancel(&preview.id).unwrap();
            assert!(
                app.ai_agent_execute(approval(&answer), &CancellationToken::new())
                    .await
                    .is_err()
            );
        }
        assert!(!calls.lock().unwrap().iter().any(|c| c.contains("image rm")));
        assert_eq!(rows.lock().unwrap().len(), 1);
        app.shutdown().await;
        sshd.abort();
    }
}

#[tokio::test]
async fn ssh_agent_stops_after_inflight_mutation_on_cancel_and_preserves_uncertain_result() {
    let mut delayed = image('a', "<none>");
    delayed["delayDelete"] = json!(true);
    let rows = Arc::new(Mutex::new(vec![delayed, image('b', "<none>")]));
    let (_dir, app, preview, answer, calls, sshd) = task(rows.clone()).await;
    let cancel = CancellationToken::new();
    let work = app.ai_agent_execute(approval(&answer), &cancel);
    let stop = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.contains("image rm --no-prune"))
            {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        app.ai_cancel(&preview.id).unwrap();
    };
    let (result, ()) = tokio::join!(work, stop);
    let result = result.unwrap();
    assert!(!result.success);
    assert_eq!(
        result
            .agent
            .unwrap()
            .steps
            .iter()
            .map(|s| s.status.as_str())
            .collect::<Vec<_>>(),
        vec!["unverified", "skipped"]
    );
    assert_eq!(rows.lock().unwrap().len(), 1);
    app.shutdown().await;
    sshd.abort();
}

//! Explicit live-provider check. API Key is read from stdin, never args/env/files.
use serverdeck_application::Application;
use serverdeck_core::ai::*;
use std::io::{self, BufRead};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let url = args
        .get(1)
        .ok_or("usage: ai_live_probe BASE_URL MODEL (key on stdin)")?;
    let model = args.get(2).ok_or("model required")?;
    let mut key = Zeroizing::new(String::new());
    io::stdin().lock().read_line(&mut key)?;
    let key = Zeroizing::new(key.trim().to_owned());
    let dir = tempfile::tempdir()?;
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs"))?;
    let config = Config {
        base_url: url.clone(),
        model: model.clone(),
        allow_insecure_http: url.starts_with("http://"),
        max_output_tokens: 1024,
        ..Default::default()
    };
    let mut registered = None;
    let result = async {
        let mut registration = ModelInput {
            id:None,expected_revision:None,name:"Live API probe".into(),
            config: config.clone(), api_key: Some(key), clear_key: false,
        test_id: None,
        };
        registration.test_id = Some(app.ai_model_test(ModelInput { id:None,expected_revision:None,name:registration.name.clone(), config:registration.config.clone(),api_key:registration.api_key.clone(),clear_key:false,test_id:None }).await?.id);
        let model=app.ai_model_save(registration).await?.value;
        registered=Some(model.clone());
        println!("{}",serde_json::json!({"liveResponse":true,"connectionTestPassed":true,"registeredModel":model.id,"credentialExposed":false}));
        Ok::<_,serverdeck_core::Error>(())
    }.await;
    let cleanup = if let Some(model) = registered {
        app.ai_model_delete(ModelDeleteInput {
            id: model.id,
            expected_revision: model.revision,
            confirmed: true,
        })
        .await
    } else {
        app.cleanup_secrets().await
    };
    app.shutdown().await;
    match cleanup {
        Ok(cleanup) if cleanup.warnings.is_empty() => (),
        outcome => {
            // Preserve durable GC metadata if the OS vault/database is unavailable.
            eprintln!(
                "temporary credential cleanup incomplete; metadata retained at {}",
                dir.keep().display()
            );
            return match outcome {
                Err(error) => Err(error.into()),
                Ok(_) => Err("temporary OS credential cleanup incomplete".into()),
            };
        }
    }
    println!("temporary OS credential removed");
    result?;
    Ok(())
}

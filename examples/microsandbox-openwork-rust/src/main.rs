use anyhow::{Context, Result};
use microsandbox::{ExecEvent, NetworkPolicy, Sandbox};
use reqwest::StatusCode;
use std::env;
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() -> Result<()> {
    let image = env::var("OPENWORK_MICROSANDBOX_IMAGE")
        .unwrap_or_else(|_| "openwork-microsandbox:dev".to_string());
    let name = env::var("OPENWORK_MICROSANDBOX_NAME")
        .unwrap_or_else(|_| "openwork-microsandbox-rust".to_string());
    let workspace_volume = env::var("OPENWORK_MICROSANDBOX_WORKSPACE_VOLUME")
        .unwrap_or_else(|_| format!("{name}-workspace"));
    let data_volume =
        env::var("OPENWORK_MICROSANDBOX_DATA_VOLUME").unwrap_or_else(|_| format!("{name}-data"));
    let replace = env_flag("OPENWORK_MICROSANDBOX_REPLACE");
    let host_port = env::var("OPENWORK_MICROSANDBOX_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let connect_host =
        env::var("OPENWORK_CONNECT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let client_token =
        env::var("OPENWORK_TOKEN").unwrap_or_else(|_| "microsandbox-token".to_string());
    let host_token =
        env::var("OPENWORK_HOST_TOKEN").unwrap_or_else(|_| "microsandbox-host-token".to_string());

    println!(
        "Starting microsandbox `{name}` from image `{image}` on http://{connect_host}:{host_port}"
    );

    ensure_named_volume(&workspace_volume).await?;
    ensure_named_volume(&data_volume).await?;

    let mut builder = Sandbox::builder(&name)
        .image(image.as_str())
        .memory(2048)
        .cpus(2)
        .env("OPENWORK_CONNECT_HOST", &connect_host)
        .env("OPENWORK_TOKEN", &client_token)
        .env("OPENWORK_HOST_TOKEN", &host_token)
        .env("OPENWORK_APPROVAL_MODE", "auto")
        .port(host_port, 8787)
        .volume("/workspace", |v| v.named(&workspace_volume))
        .volume("/data", |v| v.named(&data_volume))
        .network(|n| n.policy(NetworkPolicy::allow_all()));

    if replace {
        builder = builder.replace();
    }

    let sandbox = builder
        .create()
        .await
        .with_context(|| {
            format!(
                "failed to create microsandbox from image `{image}`; if this image only exists in Docker, push it to a registry or otherwise make it available as an OCI image reference first"
            )
        })?;

    let server = sandbox
        .exec_stream(
            "/bin/sh",
            ["-lc", "/usr/local/bin/microsandbox-entrypoint.sh"],
        )
        .await
        .context("failed to start the OpenWork microsandbox entrypoint inside the VM")?;

    let log_task = tokio::spawn(async move {
        let mut server = server;
        while let Some(event) = server.recv().await {
            match event {
                ExecEvent::Stdout(data) => print!("{}", String::from_utf8_lossy(&data)),
                ExecEvent::Stderr(data) => eprint!("{}", String::from_utf8_lossy(&data)),
                ExecEvent::Exited { code } => {
                    eprintln!("microsandbox entrypoint exited with code {code}");
                    break;
                }
                _ => {}
            }
        }
    });

    let base_url = format!("http://127.0.0.1:{host_port}");
    wait_for_health(&base_url).await?;
    verify_remote_connect(&base_url, &client_token).await?;

    println!();
    println!("Health check passed: {base_url}/health");
    println!("Remote connect URL: http://{connect_host}:{host_port}");
    println!("Remote connect token: {client_token}");
    println!("Host/admin token: {host_token}");
    println!("Workspace volume: {workspace_volume}");
    println!("Data volume: {data_volume}");
    println!("Sandbox logs are streaming below.");
    println!("Press Ctrl+C to stop the sandbox.");

    tokio::signal::ctrl_c()
        .await
        .context("failed waiting for Ctrl+C")?;
    println!("Stopping microsandbox `{name}`...");
    sandbox
        .stop()
        .await
        .context("failed to stop microsandbox")?;
    let _ = tokio::time::timeout(Duration::from_secs(5), log_task).await;

    Ok(())
}

fn env_flag(name: &str) -> bool {
    matches!(
        env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

async fn ensure_named_volume(name: &str) -> Result<()> {
    match microsandbox::Volume::get(name).await {
        Ok(_) => Ok(()),
        Err(microsandbox::MicrosandboxError::VolumeNotFound(_)) => {
            microsandbox::Volume::builder(name)
                .create()
                .await
                .with_context(|| format!("failed to create named volume `{name}`"))?;
            Ok(())
        }
        Err(error) => Err(error).with_context(|| format!("failed to access volume `{name}`")),
    }
}

async fn wait_for_health(base_url: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let health_url = format!("{base_url}/health");

    loop {
        match client.get(&health_url).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(_) | Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Ok(response) => {
                anyhow::bail!("health check failed with status {}", response.status());
            }
            Err(error) => {
                return Err(error).context("health check never succeeded before timeout");
            }
        }
    }
}

async fn verify_remote_connect(base_url: &str, token: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let workspaces_url = format!("{base_url}/workspaces");

    let unauthorized = client
        .get(&workspaces_url)
        .send()
        .await
        .context("failed to query workspaces without auth")?;
    if unauthorized.status() != StatusCode::UNAUTHORIZED {
        anyhow::bail!(
            "expected unauthenticated /workspaces to return 401, got {}",
            unauthorized.status()
        );
    }

    let authorized = client
        .get(&workspaces_url)
        .bearer_auth(token)
        .send()
        .await
        .context("failed to query workspaces with client token")?;
    if !authorized.status().is_success() {
        anyhow::bail!(
            "expected authenticated /workspaces to succeed, got {}",
            authorized.status()
        );
    }

    Ok(())
}

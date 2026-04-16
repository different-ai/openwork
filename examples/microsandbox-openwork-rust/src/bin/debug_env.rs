use anyhow::Result;
use microsandbox::{NetworkPolicy, Sandbox};

#[tokio::main]
async fn main() -> Result<()> {
    let sandbox = Sandbox::builder("owmsb-env-debug")
        .image("ttl.sh/openwork-microsandbox-11559:1d")
        .replace()
        .memory(1024)
        .cpus(1)
        .network(|n| n.policy(NetworkPolicy::allow_all()))
        .create()
        .await?;

    let out = sandbox
        .exec(
            "/bin/sh",
            [
                "-lc",
                "id; pwd; echo HOME=$HOME; echo USER=$USER; echo SHELL=$SHELL; env | sort | grep -E '^(HOME|USER|SHELL|XDG|PATH)=' || true; ls -ld /root /tmp /workspace /data 2>/dev/null || true; /usr/local/bin/opencode --version; rm -f /tmp/opencode.log; (/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/opencode.log 2>&1 &) ; sleep 5; echo '--- HEALTH ---'; curl -iS http://127.0.0.1:4096/health || true; echo; echo '--- SESSION CREATE ---'; curl -iS -X POST -H 'content-type: application/json' -d '{\"title\":\"debug\"}' http://127.0.0.1:4096/session || true; echo; echo '--- PROVIDER ---'; curl -iS http://127.0.0.1:4096/provider || true; echo; echo '--- OPENCODE LOG ---'; cat /tmp/opencode.log || true",
            ],
        )
        .await?;

    println!("stdout:\n{}", out.stdout()?);
    eprintln!("stderr:\n{}", out.stderr()?);

    sandbox.stop().await?;
    Ok(())
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const start = readFileSync(new URL("./start-daytona-server.sh", import.meta.url), "utf8");
const selector = start.split("<<'COHOST_IP_JS'\n")[1].split("\nCOHOST_IP_JS")[0];
const smtpSource = start.split("<<'WORKSHOP_SMTP_JS'\n")[1].split("\nWORKSHOP_SMTP_JS")[0];
const { createDiscardServer } = await import(`data:text/javascript;base64,${Buffer.from(smtpSource).toString("base64")}`);

async function smtpFixture(t) {
  const server = createDiscardServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    port: server.address().port,
    async connect() {
      const socket = net.connect(server.address().port, "127.0.0.1");
      sockets.push(socket);
      socket.setTimeout(3000, () => socket.destroy(new Error("test SMTP timeout")));
      let buffer = "";
      const lines = [];
      const readers = [];
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (readers.length) readers.shift()(line);
          else lines.push(line);
        }
      });
      const read = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => readers.push(resolve));
      assert.equal(await read(), "220 workshop-discard ESMTP");
      return {
        socket,
        read,
        async command(line, code) {
          socket.write(`${line}\r\n`);
          const reply = await read();
          assert.equal(reply.slice(0, 3), code, reply);
          return reply;
        },
      };
    },
  };
}

test("private SMTP accepts fake recipients, discards DATA and rejects real domains and auth", async (t) => {
  const fixture = await smtpFixture(t);
  const client = await fixture.connect();
  await client.command("DATA", "503");
  await client.command("EHLO test", "250");
  assert.equal(await client.read(), "250 SIZE 1048576");
  await client.command("AUTH PLAIN ignored", "502");
  await client.command("STARTTLS", "502");
  await client.command("MAIL FROM:<host@workshop.test>", "250");
  for (const address of ["user@example.com", "user@sub.workshop.test", "user@workshop.test.evil", "@workshop.test", "a..b@workshop.test", "a b@workshop.test", `${"a".repeat(65)}@workshop.test`, "user@wörkshop.test"]) {
    await client.command(`RCPT TO:<${address}>`, "550");
  }
  await client.command("DATA", "503");
  await client.command("RCPT TO:<fake.member+1@workshop.test>", "250");
  await client.command("DATA", "354");
  // Fragmented framing and dot-stuffed body must not be treated as commands.
  client.socket.write("Subject: secret\r\n\r\n..body\r\nRCPT TO:<real@example.com>\r\n.");
  client.socket.write("\r\n");
  assert.equal(await client.read(), "250 Discarded");
  await client.command("DATA", "503");
  await client.command("MAIL FROM:<>", "250");
  await client.command("RCPT TO:<next@WORKSHOP.TEST>", "250");
  await client.command("RSET", "250");
  await client.command("DATA", "503");
  await client.command("NOOP", "250");
  await client.command("QUIT", "221");
});

test("SMTP limits message and command buffers", async (t) => {
  const fixture = await smtpFixture(t);
  const client = await fixture.connect();
  await client.command("EHLO test", "250");
  await client.read();
  await client.command("MAIL FROM:<host@workshop.test>", "250");
  await client.command("RCPT TO:<fake@workshop.test>", "250");
  await client.command("DATA", "354");
  client.socket.write("x".repeat(1024 * 1024 + 1));
  assert.match(await client.read(), /^552 /);
  const other = await fixture.connect();
  other.socket.write("x".repeat(4097));
  assert.match(await other.read(), /^552 /);
});

test("SMTP is workshop-only, loopback, detached, credential-free and has no outbox", () => {
  const block = start.slice(start.indexOf('  smtp_script="'), start.indexOf("\nMYSQL_ROOT_CMD="));
  assert.match(block, /chmod 600/);
  assert.match(block, /server\.listen\(2525, '127\.0\.0\.1'/);
  assert.match(block, /detached: true/);
  assert.match(block, /env: \{\}/);
  assert.match(block, /SMTP_HOST=127\.0\.0\.1 SMTP_PORT=2525 SMTP_SECURE=false/);
  assert.match(block, /SMTP_USER= SMTP_PASS=/);
  assert.doesNotMatch(smtpSource, /createWriteStream|appendFile|console\.log|node:http|pkill/);
  assert.match(smtpSource, /args\[1\] !== '\/tmp\/workshop-smtp\.mjs'/);
  assert.match(smtpSource, /if \(!await healthy\(\)\)/);
});

test("actual Nodemailer transport can send invitations without TLS or authentication", async (t) => {
  let nodemailer;
  for (const path of ["../ee/apps/den-api/package.json", "../packages/email/package.json"]) {
    try { nodemailer = createRequire(new URL(path, import.meta.url))("nodemailer"); break; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  if (!nodemailer) { t.skip("needs: installed Nodemailer dependency"); return; }
  const fixture = await smtpFixture(t);
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: fixture.port, secure: false, logger: false, debug: false });
  t.after(() => transport.close());
  const result = await transport.sendMail({ from: "Workshop <host@workshop.test>", to: "member@workshop.test", subject: "Invitation", text: "Discard this fake invitation" });
  assert.deepEqual(result.accepted, ["member@workshop.test"]);
  await assert.rejects(transport.sendMail({ from: "host@workshop.test", to: "real@example.com", text: "Must not deliver" }), /550/);
});
function select(addresses, interfaces) {
  let output = "";
  runInNewContext(selector, {
    require: (name) => {
      assert.equal(name, "node:os");
      return { networkInterfaces: () => ({ eth0: interfaces }) };
    },
    process: { argv: ["node", "-", addresses], stdout: { write: (text) => { output += text; } }, exit: () => { throw new Error("no private interface"); } },
    console: { error: () => {} },
  });
  return output;
}
const iface = (address, internal = false) => ({ address, internal, family: "IPv4" });

test("selects an actual RFC1918 container interface, never a loopback alias", () => {
  for (const ip of ["172.20.0.20", "10.1.2.3", "192.168.5.10"]) {
    assert.equal(select(`127.0.0.1 ${ip} `, [iface("127.0.0.1", true), iface(ip)]), ip);
  }
});

test("rejects public, loopback, non-owned, malformed and internal addresses", () => {
  for (const ip of ["127.0.0.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "10.0.0.999", "::1", "localhost"]) {
    assert.throws(() => select(ip, [iface(ip)]), /no private interface/);
  }
  assert.throws(() => select("172.20.0.20", [iface("172.20.0.21")]), /no private interface/);
  assert.throws(() => select("172.20.0.20", [iface("172.20.0.20", true)]), /no private interface/);
});

test("cohosting requires private confirmation, production mode and Gateway before mutations", () => {
  const prefix = start.split("\nMYSQL_ROOT_CMD=(run_root mysql -uroot)\n")[0];
  const base = { ...process.env, OPENWORK_WORKSPACE_DIR: process.cwd(), OPENWORK_WORKSHOP_PRIVATE_COHOST: "1", OPENWORK_DAYTONA_PRIVATE_SANDBOX: "1", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: "true" };
  for (const change of [{ OPENWORK_DAYTONA_PRIVATE_SANDBOX: "0" }, { OPENWORK_DEV_MODE: "1" }, { GATEWAY_ENABLED: "false" }]) {
    const result = spawnSync("bash", ["-c", prefix], { env: { ...base, ...change }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workshop cohosting requires/);
  }
  const disabled = spawnSync("bash", ["-c", prefix], { env: { ...base, OPENWORK_WORKSHOP_PRIVATE_COHOST: "0" }, encoding: "utf8" });
  assert.equal(disabled.status, 0, disabled.stderr);
});

test("private-interface MySQL has no network root or fixed password: only a per-boot, single-database, single-host Den account", () => {
  const sqlBlock = start.slice(start.indexOf('if [ "${OPENWORK_WORKSHOP_PRIVATE_COHOST:-0}" = "1" ]; then\n  # MySQL listens'), start.indexOf('echo "==> Installing dependencies if needed..."'));
  assert.ok(sqlBlock.includes("CREATE USER 'openwork_den'"), "cohost SQL block found");
  const run = (flag) => spawnSync("bash", ["-c", `MYSQL_ROOT_CMD=(cat)\n${sqlBlock}`], {
    env: { ...process.env, OPENWORK_WORKSHOP_PRIVATE_COHOST: flag, COHOST_IP: "172.20.0.34", WORKSHOP_DB_PASSWORD: "f".repeat(48) }, encoding: "utf8" });
  const cohost = run("1");
  assert.equal(cohost.status, 0, cohost.stderr);
  assert.match(cohost.stdout, /DROP USER IF EXISTS 'root'@'%';/);
  assert.match(cohost.stdout, /CREATE USER 'openwork_den'@'172\.20\.0\.34' IDENTIFIED BY 'f{48}';/);
  assert.match(cohost.stdout, /GRANT ALL PRIVILEGES ON openwork_den\.\* TO 'openwork_den'@'172\.20\.0\.34';/);
  assert.doesNotMatch(cohost.stdout, /'root'@'%' IDENTIFIED|ON \*\.\* TO 'root'@'%'|'openwork_den'@'%' IDENTIFIED/);
  // Normal previews keep their existing loopback-only defaults unchanged.
  assert.match(run("0").stdout, /CREATE USER IF NOT EXISTS 'root'@'%'/);
  // The Den URL on the private interface never carries the fixed root credential.
  const url = start.slice(start.indexOf("WORKSHOP_DB_PASSWORD=\"$(node"), start.indexOf('export GATEWAY_PROXY_BASE_URL="http://$COHOST_IP'));
  assert.match(url, /mysql:\/\/openwork_den:\$WORKSHOP_DB_PASSWORD@\$COHOST_IP:3306\/openwork_den/);
  assert.doesNotMatch(url, /root:password/);
});

test("production workshop Gateway CORS uses only existing public HTTPS app origins", () => {
  const block = start.slice(start.indexOf('  GATEWAY_CORS_ORIGINS="$CORS_ORIGINS"'), start.indexOf('  pkill -f "tsx src/server.ts"'));
  const env = { ...process.env, CORS_ORIGINS: "http://localhost:3005", DEN_WEB_PUBLIC_URL: "https://web.example.test", DEN_API_PUBLIC_URL: "https://api.example.test" };
  for (const flag of ["0", "1"]) {
    const result = spawnSync("bash", ["-c", `${block}\nprintf '%s' "$GATEWAY_CORS_ORIGINS"`], { env: { ...env, OPENWORK_WORKSHOP_PRIVATE_COHOST: flag }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, flag === "1" ? "https://web.example.test,https://api.example.test" : env.CORS_ORIGINS);
  }
  assert.match(start, /CORS_ORIGINS="\$GATEWAY_CORS_ORIGINS"/);
});

test("wrapper rejects workshop cohosting without --private before provider calls", () => {
  const result = spawnSync("bash", [".devcontainer/test-server-on-daytona.sh", "a".repeat(40)], {
    env: { ...process.env, OPENWORK_DEN_EXTRA_ENV_B64: Buffer.from("OPENWORK_WORKSHOP_PRIVATE_COHOST=1\n").toString("base64") },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /workshop private cohosting requires --private/);
});

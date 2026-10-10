import { test } from "node:test";
import assert from "node:assert/strict";
import { withContractDatabase } from "../den-contract-database.mjs";

function fixture() {
  const queries = [];
  let ended = false;
  let credentials;
  return {
    queries,
    get ended() { return ended; },
    get credentials() { return credentials; },
    connect: async (options) => {
      credentials = options;
      return {
        query: async (sql) => { queries.push(sql); },
        end: async () => { ended = true; },
      };
    },
  };
}

test("contract export owns a new database, not the database in the connection URL", async () => {
  const f = fixture();
  await withContractDatabase(async (url) => {
    const database = new URL(url).pathname.slice(1);
    assert.match(database, /^openwork_contract_[a-f0-9]{32}$/);
    assert.equal(f.queries[0], `CREATE DATABASE \`${database}\``);
    assert.equal(f.ended, false);
  }, { url: "mysql://local:password@127.0.0.1:3307/do_not_touch", connect: f.connect });
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1], f.queries[0].replace("CREATE", "DROP"));
  assert.equal(f.ended, true);
  assert.equal(f.credentials.port, 3307);
  assert.equal(f.credentials.database, undefined);
});

test("failed generation still drops its database and closes the connection", async () => {
  const f = fixture();
  await assert.rejects(withContractDatabase(async () => { throw new Error("snapshot failed"); }, {
    url: "mysql://local:password@localhost", connect: f.connect,
  }), /snapshot failed/);
  assert.equal(f.queries.length, 2);
  assert.match(f.queries[1], /^DROP DATABASE/);
  assert.equal(f.ended, true);
});

test("failed database creation does not drop any database", async () => {
  let ended = false;
  await assert.rejects(withContractDatabase(async () => assert.fail("must not generate"), {
    url: "mysql://local:password@localhost",
    connect: async () => ({
      query: async () => { throw new Error("permission denied"); },
      end: async () => { ended = true; },
    }),
  }), /permission denied/);
  assert.equal(ended, true);
});

for (const url of ["mysql://local:password@database.example.test/app", "https://localhost", "mysql://127.0.0.1.example.test"]) {
  test(`remote or invalid connection is rejected before connecting: ${new URL(url).hostname}`, async () => {
    await assert.rejects(withContractDatabase(async () => assert.fail("must not generate"), {
      url, connect: async () => assert.fail("must not connect"),
    }), /local MySQL/);
  });
}

test("missing MySQL gives an actionable error without printing credentials", async () => {
  await assert.rejects(withContractDatabase(async () => assert.fail("must not generate"), {
    url: "mysql://local:private-password@localhost",
    connect: async () => { throw new Error("connection refused: private-password"); },
  }), (error) => {
    assert.match(error.message, /pnpm dev:den:mysql/);
    assert.ok(!error.message.includes("private-password"));
    return true;
  });
});

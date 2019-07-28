const { Client, ObjectReader, ArrayReader, CopyReader } = require('.');
const assert = require('assert');

async function testProtocolState(client) {
    let result = await client.query('SELECT * FROM users LIMIT 10');
    assert(result.rows.length === 10, `SELECT 1 got ${result.rows.length} users but wanted 10`);
    assert(result.completes.length === 1, 'SELECT 1 got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 10, 'SELECT 1 has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'SELECT', 'SELECT 1 has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('CREATE TABLE IF NOT EXISTS users_test (name text, email text, password text)');
    assert(result.rows.length === 0, 'CREATE TABLE got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'CREATE TABLE got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'CREATE TABLE', 'CREATE TABLE has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('DELETE FROM users_test WHERE password = $1', ['baz']);
    assert(result.rows.length === 0, 'DELETE got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'DELETE got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'DELETE', 'DELETE has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('INSERT INTO users_test (name, email, password) VALUES ($1, $2, $3) RETURNING password', ['foo', 'bar', 'baz']);
    assert(result.rows.length === 1, 'INSERT got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.rows[0].password === 'baz', 'INSERT did not return password' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'INSERT got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 1, 'INSERT has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'INSERT', 'INSERT has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('SELECT name, email, password FROM users_test WHERE password = $1', ['baz']);
    assert(result.rows.length === 1, 'SELECT 2 got wrong number of rows') + ` ${JSON.stringify(result.rows)}`;
    assert(result.rows[0].name === 'foo', 'SELECT 2 did not get right name' + ` ${JSON.stringify(result.rows)}`);
    assert(result.rows[0].email === 'bar', 'SELECT 2 did not get right email' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'SELECT 2 got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 1, 'SELECT 2 has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'SELECT', 'SELECT 2 has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('INSERT INTO users_test (name, email, password) VALUES ($1, $2, $3)', ['fox', 'bax', 'baz']);
    assert(result.rows.length === 0, 'INSERT 2 got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'INSERT 2 got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 1, 'INSERT 2 has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'INSERT', 'INSERT 2 has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('UPDATE users_test SET name = $1 WHERE password = $2', ['qux', 'baz']);
    assert(result.rows.length === 0, 'UPDATE got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'UPDATE got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 2, 'UPDATE has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'UPDATE', 'UPDATE has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('SELECT name, email, password FROM users_test WHERE password = $1', ['baz']);
    assert(result.rows.length === 2, 'SELECT 3 got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.rows.every(r => r.password === 'baz' && r.name === 'qux'), 'SELECT 3 rows have wrong password or name' + ` ${JSON.stringify(result.rows)}`)
    assert(result.completes.length === 1, 'SELECT 3 got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 2, 'SELECT 3 has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'SELECT', 'SELECT 3 has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

    result = await client.query('DELETE FROM users_test WHERE password = $1', ['baz']);
    assert(result.rows.length === 0, 'DELETE 2 got wrong number of rows' + ` ${JSON.stringify(result.rows)}`);
    assert(result.completes.length === 1, 'DELETE 2 got wrong number of completes' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].rowCount === 2, 'DELETE 2 has wrong rowCount' + ` ${JSON.stringify(result.completes)}`);
    assert(result.completes[0].cmd === 'DELETE', 'DELETE 2 has wrong cmd' + ` ${JSON.stringify(result.completes)}`)

}

module.exports = async function runTest(client) {
    let t0, result, copyResult;
    const promises = [];


    // Partial queries
    await testProtocolState(client);
    t0 = Date.now();
    result = 0;
    client.startQuery('SELECT * FROM users', []);
    while (client.inQuery) {
        result += (await client.getResults(100)).rows.length;
    }
    console.error(`received ${result} rows`);
    console.error(1000 * result / (Date.now() - t0), 'partial query (100 rows per execute) rows per second');

    await testProtocolState(client);
    t0 = Date.now();
    result = 0;
    client.startQuery('SELECT * FROM users', []);
    while (client.inQuery) {
        result += (await client.getResults(100)).rows.length;
        if (result >= 10000) {
            await client.sync();
            break;
        }
    }
    console.error(`received ${result} rows`);
    console.error(1000 * result / (Date.now() - t0), 'partial query (early exit) rows per second');

    await testProtocolState(client);
    for (var i = 0; i < 30000; i++) {
        if (i % 1000 === 0) {
            await Promise.all(promises);
            process.stderr.write(`\rwarming up ${i} / 30000     `);
        }
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    process.stderr.write(`\rwarming up ${i} / 30000\n`);
    result = await Promise.all(promises);
    promises.splice(0);
    await testProtocolState(client);
    t0 = Date.now();
    for (var i = 0; i < 30000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    result = await Promise.all(promises);
    console.error(1000 * result.length / (Date.now() - t0), 'random queries per second');
    promises.splice(0);

    await testProtocolState(client);
    t0 = Date.now();
    result = await client.query('SELECT * FROM users', [], new ArrayReader());
    console.error(1000 * result.rows.length / (Date.now() - t0), 'query rows per second');
    copyResult = result;

    await testProtocolState(client);
    result = await client.query('DELETE FROM users_copy');
    console.error(`Deleted ${result.completes[0].rowCount} rows from users_copy`);

    await testProtocolState(client);
    t0 = Date.now();
    const userFields = copyResult.rowParser.fields.map(f => f.name);
    const insertQueryString = `
        INSERT INTO users_copy 
        (${userFields.join(",")}) 
        VALUES 
        (${userFields.map((_,i) => `$${i+1}`).join(",")})
    `;
    // console.error(insertQueryString);
    // console.error(copyResult.rows[0]);
    client.query('BEGIN');
    result = 0;
    copyResult.rows.splice(30000); // Leave only 30k rows
    for (let i = 0; i < copyResult.rows.length; i++) {
        promises.push(client.query(insertQueryString, copyResult.rows[i]));
    }
    result += (await Promise.all(promises)).length;
    await client.query('COMMIT');
    console.error(1000 * result / (Date.now() - t0), 'inserts per second');
    promises.splice(0);
    copyResult = null;
    result = null;

    await testProtocolState(client);
    t0 = Date.now();
    result = await client.copy('COPY users TO STDOUT (FORMAT text)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'text copyTo rows per second');
    // console.error(result.rows[0].toString());

    await testProtocolState(client);
    t0 = Date.now();
    result = await client.copy('COPY users TO STDOUT (FORMAT csv)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'csv copyTo rows per second');
    // console.error(result.rows[0].toString());


    await testProtocolState(client);
    t0 = Date.now();
    result = await client.copy('COPY users TO STDOUT (FORMAT binary)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'binary copyTo rows per second');
    // console.error(result.rows[0]);
    copyResult = result;

    await testProtocolState(client);
    result = await client.query('DELETE FROM users_copy');
    console.error(`Deleted ${result.completes[0].rowCount} rows from users_copy`);

    await testProtocolState(client);
    t0 = Date.now();
    let copyIn = await client.copy('COPY users_copy FROM STDIN (FORMAT binary)');
    for (let i = 0; i < copyResult.rows.length; i += 1000) {
        const chunk = Buffer.concat(copyResult.rows.slice(i, i + 1000));
        client.copyData(chunk);
    }
    await client.copyDone(copyIn);
    console.error(1000 * copyResult.rows.length / (Date.now() - t0), 'binary copyFrom rows per second');
    copyResult = null;

    await testProtocolState(client);

}

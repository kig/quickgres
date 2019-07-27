const { Client, ObjectReader, ArrayReader, CopyReader } = require('.');

module.exports = async function runTest(client) {
    let t0, result, copyResult;
    const promises = [];

    result = await client.simpleQuery("SELECT * FROM users LIMIT 1; INSERT INTO users_copy (name) VALUES ('Ilmarillion Heikevatar'); SELECT * FROM users_copy LIMIT 1;");
    console.error(`Triple query resulted into ${result.rows.length} rows`);

    // Partial queries
    t0 = Date.now();
    result = 0;
    client.startQuery('SELECT * FROM users', []);
    while (client.inQuery) {
        result += (await client.getResults(100)).rows.length;
    }
    console.error(`received ${result} rows`);
    console.error(1000 * result / (Date.now() - t0), 'partial query (100 rows per execute) rows per second');

    t0 = Date.now();
    result = 0;
    client.startQuery('SELECT * FROM users', []);
    while (client.inQuery) {
        result += (await client.getResults(100)).rows.length;
        if (result >= 10000) {
            client.sync();
            await client.streamPromise();
            break;
        }
    }
    console.error(`received ${result} rows`);
    console.error(1000 * result / (Date.now() - t0), 'partial query (early exit) rows per second');

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
    t0 = Date.now();
    for (var i = 0; i < 30000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    result = await Promise.all(promises);
    console.error(1000 * result.length / (Date.now() - t0), 'random queries per second');
    promises.splice(0);

    t0 = Date.now();
    result = await client.simpleQuery('SELECT * FROM users');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'simpleQuery rows per second');

    t0 = Date.now();
    result = await client.query('SELECT * FROM users', [], new ArrayReader());
    console.error(1000 * result.rows.length / (Date.now() - t0), 'query rows per second');
    copyResult = result;

    result = await client.query('DELETE FROM users_copy');
    console.error(`Deleted ${result.completes[0].rowCount} rows from users_copy`);

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

    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT text)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'text copyTo rows per second');
    // console.error(result.rows[0].toString());

    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT csv)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'csv copyTo rows per second');
    // console.error(result.rows[0].toString());


    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT binary)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'binary copyTo rows per second');
    // console.error(result.rows[0]);
    copyResult = result;

    result = await client.query('DELETE FROM users_copy');
    console.error(`Deleted ${result.completes[0].rowCount} rows from users_copy`);

    t0 = Date.now();
    let copyIn = await client.copyFrom('COPY users_copy FROM STDIN (FORMAT binary)');
    copyResult.rows.forEach(r => client.copyData(r));
    client.copyDone();
    client.sync();
    await client.streamPromise(copyIn);
    console.error(1000 * copyResult.rows.length / (Date.now() - t0), 'binary copyFrom rows per second');
    copyResult = null;
}

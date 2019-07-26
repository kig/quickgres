const { Client, CopyReader, ArrayReader } = require('.');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);

    let t0, result;

    t0 = Date.now();
    const promises = [];
    for (var i = 0; i < 40000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    result = await Promise.all(promises);
    console.error(1000 * result.reduce((s,r) => s+r.rows.length, 0) / (Date.now() - t0), 'random queries per second');

    t0 = Date.now();
    result = await client.simpleQuery('SELECT * FROM users');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'simpleQuery rows per second');

    t0 = Date.now();
    result = await client.query('SELECT * FROM users');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'query rows per second');

    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT binary)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'binary copy rows per second');
    console.error(result.rows[0]);

    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT text)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'text copy rows per second');
    console.error(result.rows[0].toString());
    let copyResult = result;

    t0 = Date.now();
    result = await client.copyTo('COPY users TO STDOUT (FORMAT csv)');
    console.error(1000 * result.rows.length / (Date.now() - t0), 'csv copy rows per second');
    console.error(result.rows[0].toString());

    result = await client.query('DELETE FROM users_copy');
    console.error(`Deleted ${result.completes[0].rowCount} rows from users_copy`);

    t0 = Date.now();
    let copyIn = await client.copyFrom('COPY users_copy FROM STDIN');
    for (let i = 0; i < copyResult.rows.length; i++) {
        client.copyData(copyResult.rows[i]);
    }
    client.copyDone();
    await client.sync(copyIn);
    console.error(1000 * copyResult.rows.length / (Date.now() - t0), 'text copy in rows per second');

    console.error('\ndone');
    await client.end();
}

go();

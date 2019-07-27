const { Client, ObjectReader, ArrayReader } = require('.');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);

    let t0, result, copyResult;

    // Partial queries
    t0 = Date.now();

    client.parse('', 'SELECT * FROM users');
    client.describeStatement('');
    client.bind('', '', []);
    const parsed = {name: '', rowParser: null};

    result = 0;
    while (true) {
        client.execute('', 100);
        client.flush();
        const r = await client.streamPromise(new ObjectReader(), parsed);
        result += r.rows.length;
        if (r.completes[0].cmd !== 'SUSPENDED') {
            break;
        }
    }
    client.sync();
    console.error(1000 * result / (Date.now() - t0), 'partial query (100 rows per execute) rows per second');

    const promises = [];
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
    await client.streamPromise();
    console.error(1000 * copyResult.rows.length / (Date.now() - t0), 'binary copyFrom rows per second');
    copyResult = null;

    console.error('\ndone');
    await client.end();
}

go();

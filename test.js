const { Client } = require('.');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);

    let t0 = Date.now();
    const promises = [];
    for (var i = 0; i < 40000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    const results = await Promise.all(promises);
    console.error(1000 * results.reduce((s,r) => s+r.rows.length, 0) / (Date.now() - t0), 'random queries per second');

    t0 = Date.now();
    const simpleUsers = await client.simpleQuery('SELECT * FROM users');
    console.error(1000 * simpleUsers.rows.length / (Date.now() - t0), 'simpleQuery rows per second');

    t0 = Date.now();
    const users = await client.query('SELECT * FROM users');
    console.error(1000 * users.rows.length / (Date.now() - t0), 'query rows per second');

    t0 = Date.now();
    const usersCopy = await client.copy('COPY users TO STDOUT (FORMAT binary)');
    console.error(1000 * usersCopy.rows.length / (Date.now() - t0), 'binary copy rows per second');
    console.error(usersCopy.rows[0]);

    t0 = Date.now();
    const usersCopyText = await client.copy('COPY users TO STDOUT (FORMAT text)');
    console.error(1000 * usersCopyText.rows.length / (Date.now() - t0), 'text copy rows per second');
    console.error(usersCopyText.rows[0].toString());

    t0 = Date.now();
    const usersCopyCSV = await client.copy('COPY users TO STDOUT (FORMAT csv)');
    console.error(1000 * usersCopyCSV.rows.length / (Date.now() - t0), 'csv copy rows per second');
    console.error(usersCopyCSV.rows[0].toString());

    console.error('\ndone');
    await client.end();
}

go();

const { Client } = require('.');
const fs = require('fs');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2], password: 'foobar', ssl: {
        servername: 'localhost',
        key: fs.readFileSync(process.env.HOME + '/.postgresql/postgresql.key'),
        cert: fs.readFileSync(process.env.HOME + '/.postgresql/postgresql.crt'),
        ca: [ fs.readFileSync(process.env.HOME + '/.postgresql/root.crt') ],
    } });
    await client.connect(5432, 'localhost');
    // console.error(client.serverParameters);

    let t0 = Date.now();
    const promises = [];
    for (var i = 0; i < 100000; i++) {
        const id = Math.floor(Math.random() * 1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE email = $1', [id]));
    }
    const results = await Promise.all(promises);
    console.error(1000 * results.reduce((s,r) => s+r.rows.length, 0) / (Date.now() - t0), 'queries per second');

    t0 = Date.now();
    const cards = await client.simpleQuery('SELECT * FROM users');
    console.error(1000 * cards.rows.length / (Date.now() - t0), 'rows per second');

    t0 = Date.now();
    const users = await client.query('SELECT * FROM users');
    console.error(1000 * users.rows.length / (Date.now() - t0), 'rows per second');

    console.error('\ndone');
    await client.end();
}

go();

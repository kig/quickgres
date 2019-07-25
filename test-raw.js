const { Client } = require('.');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    await client.query(process.argv[3], process.argv.slice(4), process.stdout);
    await client.end();
}

go();

const { Client } = require('..');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);

    await require('./tests')(client);

    console.error('\ndone\n');
    await client.end();

    console.error("Testing SSL connection");
    require('./test-ssl');
}

go();


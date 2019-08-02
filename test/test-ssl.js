const { Client } = require('..');
const fs = require('fs');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2], password: 'foobar'});
    const sslConfig = {
        servername: 'localhost',
        key: fs.readFileSync(process.env.HOME + '/.postgresql/postgresql.key'),
        cert: fs.readFileSync(process.env.HOME + '/.postgresql/postgresql.crt'),
        ca: [ fs.readFileSync(process.env.HOME + '/.postgresql/root.crt') ]
    };
    await client.connect(5432, 'localhost', sslConfig);
    // console.error(client.serverParameters);

    await require('./tests')(client);

    console.error('\ndone\n');
    await client.end();
}

go();

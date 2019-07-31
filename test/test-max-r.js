const cluster = require('cluster');
const numCPUs = require('os').cpus().length * 3;

if (cluster.isMaster) {
    for (let i = 0; i < numCPUs; i++) cluster.fork();
    let exited = 0
    cluster.on('exit', () => {
        exited++;
        if (exited == numCPUs) {
            process.stderr.write(`\n`);
            console.error('done');
        }
    });
} else {
    const { Client } = require('..');

    async function sessionR(client, id) {
        await client.query('SELECT * FROM sessions_copy s WHERE s.id = $1 AND s.deleted = FALSE', [id], Client.BINARY);
    }

    async function go() {
        const clients = [];
        for (let i = 0; i < Math.floor(1); i++) clients[i] = new Client({ user: process.env.USER, database: process.argv[2] });
        await Promise.all(clients.map(c => c.connect('/tmp/.s.PGSQL.5432')));

        let t0, result, copyResult;

        t0 = Date.now();
        let promises = [];
        result = 0;
        for (let i = 0; i < 200000; i++) {
            if (i % 1000 === 999) {
                result += (await Promise.all(promises)).length, promises = [];
                process.stderr.write(`    ${Math.floor(1000 * numCPUs * result / (Date.now() - t0))} session Rs per second              \r`);
            }
            const id = Math.floor(1+Math.random() * 900000).toString();
            promises.push(sessionR(clients[i % clients.length], id));
        }
        result += (await Promise.all(promises)).length;
        process.stderr.write(`    ${Math.floor(1000 * numCPUs * result / (Date.now() - t0))} session Rs per second              \r`);

        await Promise.all(clients.map(c => c.end()));
        process.exit();
    }
    go();
}

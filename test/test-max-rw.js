const cluster = require('cluster');
const numCPUs = 8;
const numQueries = 12800 / numCPUs;
const numConns = Math.floor(32 / numCPUs);
const numRounds = 100;
const port = '/tmp/.s.PGSQL.5432'
const host = undefined;

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

    var result = 0, resolveWait;

    async function sessionRW(client, id, i) {
        const {rows: [[uid, data]]} = await client.query('SELECT u.id, u.data FROM sessions_copy s, users_copy2 u WHERE s.id = $1 AND s.deleted = FALSE AND s.owner = u.id', [id]);
        await client.query('UPDATE users_copy2 SET data = $1 WHERE id = $2', [data.split('').reverse().join(''), uid]);
        result++;
        if (result === numQueries) resolveWait();
    }

    async function go() {
        const clients = [];
        for (let i = 0; i < numConns; i++) clients[i] = new Client({ user: process.env.USER, database: process.argv[2] });
        await Promise.all(clients.map(c => c.connect(port, host)));

        let t0, done, total = 0;

        let ts = Date.now();
        for (var i = 0; i < numRounds; i++) {
            done = new Promise((resolve, reject) => resolveWait = resolve);
            result = 0;

            t0 = Date.now();
            for (let i = 0; i < numQueries; i++) {
                const id = Math.floor(1+Math.random() * 900000).toString();
                sessionRW(clients[i % clients.length], id, i);
            }
            await done;
            process.stderr.write(`    ${Math.floor(1000 * numCPUs * result / (Date.now() - t0))} session RWs per second              \r`);
            total += result;
        }
        process.stderr.write(`    ${Math.floor(1000 * numCPUs * total / (Date.now() - ts))} session RWs per second             \r`);

        await Promise.all(clients.map(c => c.end()));
        process.exit();
    }
    go();
}

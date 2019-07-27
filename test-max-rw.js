const cluster = require('cluster');
const numCPUs = require('os').cpus().length / 2;
const { Client } = require('.');

if (cluster.isMaster) {
    for (let i = 0; i < numCPUs; i++) cluster.fork();
} else {
    const jsonChunk = '{"_id":"5d3c67b00fef75d268fc15b3","index":0,"guid":"92168a32-1161-41df-bc5a-9405237bd33a","isActive":true,"balance":"$2,385.44"}';
    async function sessionRW(client, id) {
        const {rows: [user]} = await client.query('SELECT u.id, u.data FROM sessions_copy s, users_copy2 u WHERE s.id = $1 AND s.deleted = FALSE AND s.owner = u.id', [id]);
        return client.query('UPDATE users_copy2 SET data = $1 WHERE id = $2', [jsonChunk, user.id]);
    }

    async function go() {
        const clients = [];
        for (let i = 0; i < 5; i++) clients[i] = new Client({ user: process.env.USER, database: process.argv[2] });
        await Promise.all(clients.map(c => c.connect('/tmp/.s.PGSQL.5432')));

        let t0, result, copyResult;

        t0 = Date.now();
        let promises = [];
        result = 0;
        for (let i = 0; i < 10000; i++) {
            if (i % 256 === 0) result += (await Promise.all(promises)).length, promises = [];
            const id = Math.floor(1+Math.random() * 900000).toString();
            promises.push(sessionRW(clients[i % clients.length], id));
        }
        result += (await Promise.all(promises)).length;
        console.error(1000 * numCPUs * result / (Date.now() - t0), 'session RWs per second');

        await Promise.all(clients.map(c => c.end()));
        process.exit();
    }
    go();
}
const { Client } = require('..');

async function go() {
    const client = new Client({ user: process.env.USER, database: process.argv[2] });
    await client.connect('/tmp/.s.PGSQL.5432');
    // console.error(client.serverParameters);

    var allocs = 0, allocUnsafes = 0, froms = 0;
    Buffer.__alloc = Buffer.alloc;
    Buffer.__allocUnsafe = Buffer.allocUnsafe;
    Buffer.__from = Buffer.from;
    Buffer.alloc = function(n) {
        allocs++;
        return this.__alloc(n);
    };
    Buffer.allocUnsafe = function(n) {
        allocUnsafes++;
        return this.__allocUnsafe(n);
    };
    Buffer.from = function(n,t) {
        froms++;
        return this.__from(n,t);
    };

    await require('./tests')(client);

    console.error('\ndone\n');
    await client.end();

    console.log('allocs', allocs);
    console.log('allocUnsafes', allocUnsafes);
    console.log('froms', froms);

    console.log(Array.prototype.map.call(client.packetStats, (e,i) => e ? `${i}: ${e}, varLen: ${client.packetLengths[i]}` : null).filter(s => s).join("\n"));
    process.exit();

    console.error("Testing SSL connection");
    require('./test-ssl');
}

try {
    go();
} catch(e) { 
    console.error(e);
    process.exit();
}

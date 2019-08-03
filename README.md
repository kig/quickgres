# Quickgres 0.2.3b

Quickgres is a native-JS PostgreSQL client library.

It's around 300 lines of code, with no external dependencies.

Features
 * Queries with parameters (along with prepared statements and portals).
 * Each parameterized query creates a cached prepared statement and row parser.
 * COPY protocol for speedy table dumps and inserts.
 * Lightly tested SSL connection support.
 * Plaintext & MD5 password authentication.
 * Partial query readback.
 * You should be able to execute 2GB size queries (If you want to store movies in TOAST columns? (Maybe use large objects instead.)) I haven't tried it though.
 * Canceling long running queries.
 * Binary parameters and return values
 
Lacking
 * Full test suite
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping?)
 * No type parsing (This is more like a feature.)
 * Simple queries are deprecated in favor of parameterized queries.
 * Results as objects (This is to optimize Array results performance.)

What's it good for? It's relatively small so you can read it. It doesn't have deps, so you don't need to worry about npm dephell. Mostly use it for bed-time reading.

Performance-wise it's ok.


## Usage 

```javascript
const { Client } = require('quickgres'); 

async function go() {
    const client = new Client({ user: 'myuser', database: 'mydb', password: 'mypass' });
    await client.connect('/tmp/.s.PGSQL.5432'); // Connect to a UNIX socket.
    // await client.connect(5432, 'localhost'); // Connect to a TCP socket.
    // await client.connect(5432, 'localhost', {}); // Connect to a SSL socket. See tls.connect for config obj details.
    console.error(client.serverParameters);

    // Get rows parsed to arrays.
    let { rows, completes } = await client.query(
        'SELECT name, email FROM users WHERE id = $1', ['1234']);
    console.log(rows[0][0], rows[0][1], completes[0].rowCount);

    // Query execution happens in a pipelined fashion, so when you do a million 
    // random SELECTs, they get written to the server right away, and the server
    // replies are streamed back to you.
    const promises = [];
    for (let i = 0; i < 1000000; i++) {
        const id = Math.floor(Math.random()*1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE id = $1', [id]));
    }
    const results = await Promise.all(promises);

    // Partial query results
    client.startQuery('SELECT * FROM users', []);
    while (client.inQuery) {
        const resultChunk = await client.getResults(100);
        // To stop receiving chunks, send a sync.
        if (resultChunk.rows.length > 1) {
            await client.sync();
            break;
        }
    }

    // Copy data
    const copyResult = await client.query('COPY users TO STDOUT (FORMAT binary)');
    console.log(copyResult.rows[0]);

    const copyIn = await client.query('COPY users_copy FROM STDIN (FORMAT binary)');
    console.log(copyIn.columnFormats);
    copyResult.rows.forEach(row => client.copyData(row));
    await client.copyDone();

    await client.end(); // Close the connection socket.
}

go();
```

## Changelog

 * 0.2.3b: Parallel universe branch that optimizes array of string results query performance to the hilt.

 * 0.2.2-rc1: Request canceling with `cancel`, made statement caching optional, tests for bytea roundtrips and large objects, recover from connection-time `EAGAIN`, squeeze to 349 lines.

 * 0.2.1: Allocate exact size message write buffers (yay), removed `describe` methods, more tests, inlined row parsers, added RawReader, minor optimizations, cut lines to 365 from 441.

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), 8 GB RAM, NVMe SSD, PostgreSQL 11.3.

```bash
$ node test/test.js testdb
received 1000011 rows
435355.2459730083 'partial query (100 rows per execute) rows per second'
received 10000 rows
384615.3846153846 'partial query (early exit) rows per second'
warming up 30000 / 30000     
40983.60655737705 'random queries per second'
443463.8580931264 'query rows per second'
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 5 ms
Deleted 1000011 rows from users_copy
38610.03861003861 'inserts per second'
572416.1419576417 'text copyTo rows per second'
491647.49262536876 'csv copyTo rows per second'
793660.3174603175 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
372721.58032053674 'binary copyFrom rows per second'

done

Testing SSL connection
received 1000011 rows
430667.95865633077 'partial query (100 rows per execute) rows per second'
received 10000 rows
370370.3703703704 'partial query (early exit) rows per second'
warming up 30000 / 30000     
30150.75376884422 'random queries per second'
493345.33793783915 'query rows per second'
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 110 ms
Deleted 1000011 rows from users_copy
29440.62806673209 'inserts per second'
638984.6645367412 'text copyTo rows per second'
613503.6809815951 'csv copyTo rows per second'
898483.3782569632 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
400485.38245895074 'binary copyFrom rows per second'

done

```

Simulating web session workload: Request comes in with a session id, use it to fetch user id and user data string. Update user with a modified version of the data string.

The `max-r` one is just fetching a full a session row based on session id, so it's a pure read workload.

```bash
$ node test/test-max-rw.js testdb
    31254 session RWs per second              
done

$ node test/test-max-r.js testdb
    141002 session Rs per second              
done

```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
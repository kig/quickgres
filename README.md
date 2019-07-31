# Quickgres 0.2.2-rc1

Quickgres is a native-JS PostgreSQL client library.

It's around 400 lines of code, with no external dependencies.

Features
 * Queries with parameters (along with prepared statements and portals).
 * Each parameterized query creates a cached prepared statement and row parser.
 * COPY protocol for speedy table dumps and inserts.
 * Lightly tested SSL connection support.
 * Plaintext & MD5 password authentication.
 * Partial query readback.
 * You should be able to execute 2GB size queries (If you want to store movies in TOAST columns? (Maybe use large objects instead.)) I haven't tried it though.
 * Canceling long running queries.
 
Lacking
 * Full test suite
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping?)
 * No type parsing (This is more like a feature.)
 * Binary values?
 * Simple queries are deprecated in favor of parameterized queries.

What's it good for? It's relatively small so you can read it. It doesn't have deps, so you don't need to worry about npm dephell. Mostly use it for bed-time reading.

Performance-wise it's ok.


## Usage 

```javascript
const { Client, ArrayReader } = require('quickgres'); 

async function go() {
    const client = new Client({ user: 'myuser', database: 'mydb', password: 'mypass' });
    await client.connect('/tmp/.s.PGSQL.5432'); // Connect to a UNIX socket.
    // await client.connect(5432, 'localhost'); // Connect to a TCP socket.
    console.error(client.serverParameters);

    // Get rows parsed to JS objects.
    let { rows, completes } = await client.query(
        'SELECT name, email FROM users WHERE id = $1', ['1234']);
    console.log(rows[0].name, rows[0].email, completes[0].rowCount);

    // Get rows parsed to arrays.
    let { rows, completes } = await client.query(
        'SELECT name, email FROM users WHERE id = $1', ['1234'], new ArrayReader());
    console.log(rows[0][0], rows[0][1], completes[0].rowCount);

    // Stream raw query results protocol to stdout (why waste cycles on parsing data...)
    await client.query('SELECT name, email FROM users WHERE id = $1', ['1234'], process.stdout);

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
    const copyResult = await client.copy('COPY users TO STDOUT (FORMAT binary)');
    console.log(copyResult.rows[0]);

    const copyIn = await client.copy('COPY users_copy FROM STDIN (FORMAT binary)');
    console.log(copyIn.columnFormats);
    copyResult.rows.forEach(row => client.copyData(row));
    await client.copyDone();

    await client.end(); // Close the connection socket.
}

go();
```

## Changelog

 * 0.2.2-rc1: Request canceling with `cancel`, made statement caching optional, tests for bytea roundtrips and large objects, recover from connection-time `EAGAIN`, squeeze to 349 lines.

 * 0.2.1: Allocate exact size message write buffers (yay), removed `describe` methods, more tests, inlined row parsers, added RawReader, minor optimizations, cut lines to 365 from 441.

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test/test.js testdb
received 1000011 rows
385360.6936416185 'partial query (100 rows per execute) rows per second'
received 10000 rows
357142.85714285716 'partial query (early exit) rows per second'
warming up 30000 / 30000     
41436.46408839779 'random queries per second'
665786.2849533955 'query raw rows per second'
388353.786407767 'query rows per second'
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 3 ms
444646.9542018675 'query array rows per second'
Deleted 1000011 rows from users_copy
39735.09933774835 'inserts per second'
539671.3437668645 'text copyTo rows per second'
495791.2741695588 'csv copyTo rows per second'
697358.4379358438 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
385509.63762528915 'binary copyFrom rows per second'

done

Testing SSL connection
received 1000011 rows
364435.4956268222 'partial query (100 rows per execute) rows per second'
received 10000 rows
322580.6451612903 'partial query (early exit) rows per second'
warming up 30000 / 30000     
28680.688336520077 'random queries per second'
700778.5564120533 'query raw rows per second'
412205.68837592745 'query rows per second'
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 134 ms
439565.2747252747 'query array rows per second'
Deleted 1000011 rows from users_copy
29097.963142580018 'inserts per second'
610507.326007326 'text copyTo rows per second'
582078.5797438882 'csv copyTo rows per second'
882623.1244483672 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
319492.6517571885 'binary copyFrom rows per second'

done

```

Simulating web session workload: Request comes in with a session id, use it to fetch user id and user data string. Update user with a modified version of the data string.

The `max-r` one is just fetching a full a session row based on session id, so it's a pure read workload.

```bash
$ node test/test-max-rw.js testdb
    29232 session RWs per second              
done

$ node test/test-max-r.js testdb
    119673 session Rs per second              
done
```

On a 16-core server, 2xE5-2650v2, 64 GB ECC DDR3 and Optane. (NB the `numCPUs` and connections per CPU have been tuned.)

```bash
$ node test/test-max-rw.js testdb
    82215 session RWs per second              
done

$ node test/test-max-r.js testdb
    308969 session Rs per second              
done
```

On a 16-core workstation, TR 2950X, 32 GB ECC DDR4 and flash SSD.

```bash
$ node test/test-max-rw.js testdb
    64717 session RWs per second              
done

$ node test/test-max-r.js testdb
    750755 session Rs per second              
done
```

Running server on the Optane 16-core machine, doing requests over the network from the other 16-core machine.

```bash
$ node test/test-max-rw.js testdb
    101201 session RWs per second              
done

$ node test/test-max-r.js testdb
    496499 session Rs per second               
done

```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
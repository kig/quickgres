# Quickgres 0.3.0-rc0

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
 * Binary params, binary query results.

Lacking
 * Full test suite
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping?)
 * No type parsing (This is more like a feature.)
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
    // await client.connect(5432, 'localhost', {}); // Connect to a TCP socket with SSL config (see tls.connect).
    console.error(client.serverParameters);

    // Access row fields as object properties.
    let { rows, rowCount } = await client.query(
        'SELECT name, email FROM users WHERE id = $1', ['adb42e46-d1bc-4b64-88f4-3e754ab52e81']);
    console.log(rows[0].name, rows[0].email, rowCount);
    console.log(rows[0][0], rows[0][1], rowCount);

    // You can also convert the row into an object or an array.
    assert(rows[0].toObject().name === rows[0].toArray()[0]);

    // Stream raw query results protocol to stdout (why waste cycles on parsing data...)
    await client.query(
        'SELECT name, email FROM users WHERE id = $1', 
        ['adb42e46-d1bc-4b64-88f4-3e754ab52e81'], 
        Client.STRING, // Or Client.BINARY. Controls the format of data that PostgreSQL sends you.
        true, // Cache the parsed query (default is true. If you use the query text only once, set this to false.)
        process.stdout // The result stream. Client calls stream.write(buffer) on this. See ObjectReader for details.
    );

    // Binary data
    const buf = Buffer.from([0,1,2,3,4,5,255,254,253,252,251,0]);
    const result = await client.query('SELECT $1::bytea', [buf], Client.BINARY, false);
    assert(buf.toString('hex') === result.rows[0][0].toString('hex'), "bytea roundtrip failed");

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
 
 * 0.3.0-rc0: Binary query params, binary query results, lazy result parsing, rolled ObjectReader, ArrayReader and RawReader into RowReader, questionable life choices, bloat up to 401 lines 

 * 0.2.2-rc1: Request canceling with `cancel`, made statement caching optional, tests for bytea roundtrips and large objects, recover from connection-time `EAGAIN`, squeeze to 349 lines.

 * 0.2.1: Allocate exact size message write buffers (yay), removed `describe` methods, more tests, inlined row parsers, added RawReader, minor optimizations, cut lines to 365 from 441.

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test/test.js testdb
received 1000011 rows
443463.8580931264 'partial query (100 rows per execute) rows per second'
received 10000 rows
400000 'partial query (early exit) rows per second'
warming up 30000 / 30000     
33632.28699551569 'random queries per second'
558041.8526785715 'query rows per second'
668456.550802139 'binary query rows per second'
493588.8450148075 'binary query rows as arrays per second' 10000110
322792.4467398322 'query rows as objects per second' 1000011
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 3 ms
Deleted 1000011 rows from users_copy
32292.787944025833 'inserts per second'
457670.938215103 'text copyTo rows per second'
415459.4931449938 'csv copyTo rows per second'
594537.4554102259 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
238041.418709831 'binary copyFrom rows per second'

done

Testing SSL connection
received 1000011 rows
499007.48502994014 'partial query (100 rows per execute) rows per second'
received 10000 rows
416666.6666666667 'partial query (early exit) rows per second'
warming up 30000 / 30000     
30864.197530864196 'random queries per second'
725171.1385061638 'query rows per second'
848905.7724957555 'binary query rows per second'
617290.7407407408 'binary query rows as arrays per second' 10000110
369007.74907749076 'query rows as objects per second' 1000011
Cancel test: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 14 ms
Deleted 1000011 rows from users_copy
30060.120240480963 'inserts per second'
607171.2204007286 'text copyTo rows per second'
602416.265060241 'csv copyTo rows per second'
901724.0757439134 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
373976.06581899774 'binary copyFrom rows per second'

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
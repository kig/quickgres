# Quickgres 0.4.1

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
 * Fast raw protocol pass-through to output stream
 * Client-side library for parsing PostgreSQL query results in the browser

Lacking
 * Full test suite
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping?)
 * No type parsing (This is more like a feature.)
 * Simple queries are deprecated in favor of parameterized queries.

What's it good for? 
 * It's relatively small so you can read it.
 * It doesn't have deps, so you don't need to worry about npm dephell.
 * Performance-wise it's ok. Think 100,000 DB-hitting HTTP/2 requests per second on a 16-core server.


## Usage 

```javascript
const { Client } = require('quickgres'); 

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
        process.stdout // The result stream. Client calls stream.write(buffer) on this. See RowReader for details.
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

 * 0.4.0: Optimized allocations, efficient raw protocol pass-through, client-side protocol parsing lib.

 * 0.3.1: Treating undefined as null in query parameters. DB error messages start with 'PostgreSQL Error:'.

 * 0.3.0-rc1: Removed CopyReader and rolled .copy() into .query(). Commented source code.

 * 0.3.0-rc0: Binary query params, binary query results, lazy result parsing, rolled ObjectReader, ArrayReader and RawReader into RowReader, questionable life choices, bloat up to 401 lines 

 * 0.2.2-rc1: Request canceling with `cancel`, made statement caching optional, tests for bytea roundtrips and large objects, recover from connection-time `EAGAIN`, squeeze to 349 lines.

 * 0.2.1: Allocate exact size message write buffers (yay), removed `describe` methods, more tests, inlined row parsers, added RawReader, minor optimizations, cut lines to 365 from 441.

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test/test.js testdb
46656.29860031104 'single-row-hitting queries per second'
268059 268059 1
268059 268059 1

README tests done

received 1000016 rows
573403.6697247706 'partial query (100 rows per execute) rows per second'
received 10000 rows
454545.45454545453 'partial query (early exit) rows per second'
warming up 30000 / 30000     
38510.91142490372 'random queries per second'
670241.2868632708 '100-row query rows per second'
925069.3802035153 'streamed 100-row query rows per second'
3.0024 'stream writes per query'
1170973.0679156908 'binary query rows per second piped to test.dat'
916600.3666361136 'string query rows per second piped to test_str.dat'
595247.619047619 'query rows per second'
359717.9856115108 'query rows as arrays per second' 10000160
346505.8905058905 'query rows as objects per second' 1000016
808420.3718674212 'binary query rows per second'
558980.4359977641 'binary query rows as arrays per second' 10000160
426264.27962489345 'binary query rows as objects per second' 1000016
Cancel test: PostgreSQL Error: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 18 ms
Deleted 1000016 rows from users_copy
47021.94357366771 'binary inserts per second'
530794.0552016986 'text copyTo rows per second'
461474.8500230734 'csv copyTo rows per second'
693974.3233865371 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
328089.56692913384 'binary copyFrom rows per second'

done

Testing SSL connection
30959.752321981425 'single-row-hitting queries per second'
268059 268059 1
268059 268059 1

README tests done

received 1000016 rows
454346.2062698773 'partial query (100 rows per execute) rows per second'
received 10000 rows
454545.45454545453 'partial query (early exit) rows per second'
warming up 30000 / 30000     
23094.688221709006 'random queries per second'
577034.0450086555 '100-row query rows per second'
745156.4828614009 'streamed 100-row query rows per second'
3 'stream writes per query'
1019379.2048929663 'binary query rows per second piped to test.dat'
605333.5351089588 'string query rows per second piped to test_str.dat'
508655.13733468973 'query rows per second'
277243.13834211254 'query rows as arrays per second' 10000160
252848.54614412136 'query rows as objects per second' 1000016
722033.21299639 'binary query rows per second'
432907.3593073593 'binary query rows as arrays per second' 10000160
393242.62681871804 'binary query rows as objects per second' 1000016
Cancel test: PostgreSQL Error: 83 ERROR VERROR C57014 Mcanceling statement due to user request Fpostgres.c L3070 RProcessInterrupts  
Elapsed: 41 ms
Deleted 1000016 rows from users_copy
33407.57238307349 'binary inserts per second'
528829.1909042834 'text copyTo rows per second'
501010.0200400802 'csv copyTo rows per second'
801295.6730769231 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
222176.62741612975 'binary copyFrom rows per second'

done

```

Simulating web session workload: Request comes in with a session id, use it to fetch user id and user data string. Update user with a modified version of the data string.

The `max-r` one is just fetching a full a session row based on session id, so it's a pure read workload.

```bash
$ node test/test-max-rw.js testdb
    32574 session RWs per second              
done

$ node test/test-max-r.js testdb
    130484 session Rs per second              
done
```

Yes, the laptop hits Planetary-1: one request per day per person on the planet. On the RW-side, it could serve 2.8 billion requests per day. Note that the test DB fits in RAM, so if you actually wanted to store 1k of data per person, you'd need 10 TB of RAM to hit this performance with 10 billion people.

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

## Support

Heichen Ltd at hei@heichen.hk

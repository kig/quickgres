# Quickgres 0.2.0

Quickgres is a native-JS PostgreSQL client library.

It's around 400 lines of code, with no external dependencies.

Features
 * Queries with parameters (along with prepared statements and portals).
 * Each parameterized query creates a cached prepared statement and row parser.
 * COPY protocol for speedy table dumps and inserts.
 * Lightly tested SSL connection support.
 * Plaintext & MD5 password authentication.
 * Partial query readback.
 * You should be able to execute 2GB size queries (If you want to store movies in TOAST columns? (Maybe use large objects instead.)) I haven't tried it though, and the write buffer is resized to the largest seen message size so you'll end up using 2GB RAM per connection if you try.
 
Lacking
 * Bullet-proof write buffer resize
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

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test.js testdb
received 1000011 rows
374535.9550561798 'partial query (100 rows per execute) rows per second'
received 10000 rows
277777.77777777775 'partial query (early exit) rows per second'
warming up 30000 / 30000     
30150.75376884422 'random queries per second'
358684.0028694405 'query rows per second'
Deleted 1000011 rows from users_copy
41379.31034482759 'inserts per second'
498013.44621513947 'text copyTo rows per second'
457670.938215103 'csv copyTo rows per second'
626573.9348370928 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
256347.60317867214 'binary copyFrom rows per second'

done

Testing SSL connection
received 1000011 rows
347588.11261730967 'partial query (100 rows per execute) rows per second'
received 10000 rows
384615.3846153846 'partial query (early exit) rows per second'
warming up 30000 / 30000     
25146.68901927913 'random queries per second'
368192.56259204715 'query rows per second'
Deleted 1000011 rows from users_copy
28571.428571428572 'inserts per second'
543779.7716150081 'text copyTo rows per second'
546752.870420995 'csv copyTo rows per second'
798731.6293929713 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
245763.5782747604 'binary copyFrom rows per second'

done

$ node test-max-rw.js testdb
    24996 session RWs per second              
done
```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
# Quickgres 0.2.1-rc0

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

 * 0.2.0: Deprecated `simpleQuery`, merged `copyTo` and `copyFrom` to `copy`, optimized number of socket writes on hot path (this improved SSL perf a bit), added more tests to tests.js, changed `sync()` and `copyDone()` to async methods to simplify API.

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test.js testdb
$ node test.js qcard
received 1000011 rows
379510.8159392789 'partial query (100 rows per execute) rows per second'
received 10000 rows
312500 'partial query (early exit) rows per second'
warming up 30000 / 30000     
35087.71929824561 'random queries per second'
604601.5719467957 'query raw rows per second'
373138.4328358209 'query rows per second'
385955.61559243535 'query array rows per second'
Deleted 1000011 rows from users_copy
40000 'inserts per second'
487334.7953216374 'text copyTo rows per second'
479391.65867689357 'csv copyTo rows per second'
655745.5737704918 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
218486.34476731485 'binary copyFrom rows per second'

done

Testing SSL connection
received 1000011 rows
354613.829787234 'partial query (100 rows per execute) rows per second'
received 10000 rows
357142.85714285716 'partial query (early exit) rows per second'
warming up 30000 / 30000     
24711.69686985173 'random queries per second'
630921.7665615142 'query raw rows per second'
403067.7146311971 'query rows per second'
450252.58892390813 'query array rows per second'
Deleted 1000011 rows from users_copy
25445.29262086514 'inserts per second'
554329.822616408 'text copyTo rows per second'
559916.5733482643 'csv copyTo rows per second'
823733.1136738056 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
260419.79166666666 'binary copyFrom rows per second'

done

$ node test-max-rw.js testdb
    24996 session RWs per second              
done

$ node test-max-r.js testdb
    133734 session Rs per second              
done
```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
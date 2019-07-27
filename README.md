# Quickgres 0.1.5-rc0

Quickgres is a native-JS PostgreSQL client library.

It's around 400 lines of code, with no external dependencies.

Features
 * Queries both simple and parameterized (along with prepared statements and portals).
 * Each parameterized query creates a cached prepared statement and row parser.
 * COPY protocol for speedy table dumps and inserts.
 * Lightly tested SSL connection support.
 * Plaintext & MD5 password authentication.
 * Partial query readback.
 * Handles multiple-statement simple queries.
 * You should be able to execute 2GB size queries (If you want to store movies in TOAST columns? (Maybe use large objects instead.)) I haven't tried it though, and the write buffer is resized to the largest seen message size so you'll end up using 2GB RAM per connection if you try.

Lacking
 * Full test suite
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping)
 * No type parsing (This is more like a feature.)

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
            client.sync();
            await client.streamPromise();
            break;
        }
    }

    // Copy data
    const copyResult = await client.copyTo('COPY users TO STDOUT (FORMAT binary)');
    console.log(copyResult.rows[0]);

    const copyIn = await client.copyFrom('COPY users_copy FROM STDIN (FORMAT binary)');
    console.log(copyIn.columnFormats);
    for (let i = 0; i < copyResult.rows.length; i++) {
        client.copyData(copyResult.rows[i]);
    }
    client.copyDone();
    client.sync();
    await client.streamPromise(copyIn);

    await client.end(); // Close the connection socket.
}

go();
```

## Test output

On a 13" Macbook Pro 2018 (2.3 GHz Intel Core i5), PostgreSQL 11.3.

```bash
$ node test.js testdb

Triple query resulted into 2 rows
received 1000011 rows
367246.05214836576 'partial query (100 rows per execute) rows per second'
received 10000 rows
263157.8947368421 'partial query (early exit) rows per second'
warming up 30000 / 30000     
32751.09170305677 'random queries per second'
366572.94721407624 'simpleQuery rows per second'
309505.10677808727 'query rows per second'
Deleted 1000012 rows from users_copy
38167.93893129771 'inserts per second'
479621.582733813 'text copyTo rows per second'
470814.97175141243 'csv copyTo rows per second'
642681.233933162 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
215798.87785930082 'binary copyFrom rows per second'

done

Testing SSL connection
Triple query resulted into 2 rows
received 1000011 rows
338757.1138211382 'partial query (100 rows per execute) rows per second'
received 10000 rows
333333.3333333333 'partial query (early exit) rows per second'
warming up 30000 / 30000     
21246.45892351275 'random queries per second'
378935.5816597196 'simpleQuery rows per second'
390019.8907956318 'query rows per second'
Deleted 1000012 rows from users_copy
24330.900243309003 'inserts per second'
581739.965095986 'text copyTo rows per second'
534479.4227685729 'csv copyTo rows per second'
813679.414157852 'binary copyTo rows per second'
Deleted 30000 rows from users_copy
97022.6059959251 'binary copyFrom rows per second'

done

```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
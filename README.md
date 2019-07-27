# Quickgres 0.1.4-rc0

Quickgres is a native-JS PostgreSQL client library.

It's around 400 lines of code, with no external dependencies.

Features
 * Queries both simple and parameterized (along with prepared statements and portals).
 * Each parameterized query creates a cached prepared statement and row parser.
 * COPY protocol for speedy table dumps and inserts.
 * Lightly tested SSL connection support.
 * Plaintext & MD5 password authentication.
 * Partial query readback in a painful way.

Lacking
 * SASL authentication
 * Streaming replication (For your JavaScript DB synced via WAL shipping)
 * No type parsing (This is more like a feature.)
 * Queries where the statement is larger than 1MB will silently fail (How about bounds checking for scratchpads?)

What's it good for? It's relatively small so you can read it. It doesn't have deps, so you don't need to worry about npm dephell. Mostly use it for bed-time reading.

Performance-wise it's roughly equivalent to `psql -Az0` for selecting a million rows as JS objects. For streaming raw results to `/dev/null`, `SELECT * FROM table` runs at a speed similar to `psql -c "COPY table TO STDOUT (FORMAT text)"`. The fastest way to dump a table is still `psql -c "COPY table TO STDOUT (FORMAT binary)"`.

There is no test suite, write one.


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

    const copyResult = await client.copyTo('COPY users TO STDOUT');
    console.log(copyResult.rows[0].toString());

    const copyIn = await client.copyFrom('COPY users_copy FROM STDIN');
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

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
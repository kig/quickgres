# Quickgres 0.1.1

Quickgres is a native-JS PostgreSQL client library.

It's around 400 lines of code, with no external dependencies.

Features
 * Only the query protocol is supported (along with prepared statements and portals).
 * Plaintext & MD5 password authentication over unencrypted sockets.
 * There are untested endpoints for calling server-side functions but no result parser. Ditto for the copy protocol.
 * Each parameterized query creates a prepared statement. If you're generating queries on the fly, use simpleQuery instead.

Lacking
 * SSL
 * Server-side function calls
 * SASL authentication
 * COPY protocol (For rapid reading and writing data?)
 * Streaming replication (Does anyone want this?)
 * No type parsing (This is more like a feature.)

What's it good for? It's relatively fast, and you can read it through and not worry about npm dephell.

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
    for (var i = 0; i < 1000000; i++) {
        const id = Math.floor(Math.random()*1000000).toString();
        promises.push(client.query('SELECT * FROM users WHERE id = $1', [id]));
    }
    const results = await Promise.all(promises);

    await client.end(); // Close the connection socket.
}

go();
```

## Author
Ilmari Heikkinen <hei@heichen.hk>

## License
MIT
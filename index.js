// Quickgres is a PostgreSQL client library.
const net = require('net'); // net is required for opening socket connections
const tls = require('tls'); // tls is required for creating encrypted SSL connections
const crypto = require('crypto'); // md5 password hashing uses the crypto lib

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; } // Read a 32-bit big-endian int from buffer buf at offset off.
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; } // Read a 16-bit big-endian int from buffer buf at offset off.
function w32(buf, v, off) { buf[off]=(v>>24)&255; buf[off+1]=(v>>16)&255; buf[off+2]=(v>>8)&255; buf[off+3]=v&255; return off+4; } // Write a 32-bit big-endian int to buffer at offset and return the offset after it.
function w16(buf, v, off) { buf[off]=(v>>8)&255; buf[off+1]=v&255; return off+2;} // Write a 16-bit big-endian int to buffer at offset and return the offset after it.

class Client { // The Client class wraps a connection socket to a PostgreSQL database and speaks the protocol.
    constructor(config) { // Client constructor takes a config object that contains parameters to pass to the server.
        if (!(config.user && config.database)) throw Error("You need to provide both 'user' and 'database' in config"); // PostgreSQL protocol requires at least a user and database.
        this._parsedStatementCount = 1; // Counter to create unique prepared statement names.
        this._parsedStatements = {}; // Index to store prepared statements. Maps from a query string to statement name and row parser.
        this._packet = { buf: null, head: Buffer.alloc(4), cmd: 0, length: 0, index: 0 }; // Stores the current incoming protocol message.
        this._queryHandlers = []; // Internal queue of query result handlers, called in order when receiving query results.
        this._formatQueue = []; // Internal queue of query result formats, either Client.STRING or Client.BINARY.
        this.serverParameters = {}; // Parameters received from the PostgreSQL server on connecting. Stuff like {server_encoding: 'UTF8'}
        this.config = config; // Store the config for later use.
    }
    connect(address, host, ssl) { // Connects to either a UNIX socket or a TCP socket, with optional SSL encryption. See Node.js net.createConnection.
        this.address = address, this.host = host, this.ssl = ssl; // Store the connection parameters for later use.
        this._connect(); // Connect using the parameters.
        return this.promise(null, null); // Wait for the initial ReadyForQuery message.
    }
    _connect() { // Internal connect helper, creates connection based on connection parameters.
        this._connection = net.createConnection(this.address, this.host); // Create net socket.
        this._connection.on('error', this.onError.bind(this)); // Deal with errors on the net socket.
        this._connection.once('connect', () => { // Upgrade to SSL on connection if wanted.
            if (this.ssl) { // We have ssl config, try to establish an SSL connection.
                this._connection.once('data', (buffer) => { // Deal with the server's response to our SSL request.
                    if (buffer[0] !== 83) throw Error("Error establishing an SSL connection"); // Error out if the server doesn't allow for SSL.
                    this._connection = tls.connect({socket: this._connection, ...this.ssl}, this.onConnect.bind(this)); // OK, upgrade to an SSL socket and make it handle the protocol.
                    this._connection.on('error', this.onError.bind(this)); // We also need to handle errors in the SSL connection.
                });
                this._connection.write(Buffer.from([0,0,0,8,4,210,22,47])); // Request SSL from the server
            } else this.onConnect(); // Proceed with an unencrypted connection.
        });
    }
    end() { // Ends the connection by terminating the PostgreSQL protocol and disconnecting.
        this.terminate(); // Send terminate message to the server.
        return this._connection.destroy(); // Disconnect socket.
    }
    onError(err) { // Deal with errors in the connection.
        if (err.message.startsWith('connect EAGAIN ')) this._connect(); // If you try to open too many UNIX sockets too quickly, the Linux syscall sends an EAGAIN interrupt asking you to try again.
        else this._formatQueue.splice(0), this._queryHandlers.splice(0).forEach(s => s.reject(err)); // Clear out the query result handlers and reject them all. 
    }
    onConnect() { // Initiate connection with PostgreSQL server by sending the startup packet.
        if (this.config.cancel) { // Unless this connection is for canceling a long-running request.
            this._connection.write(Buffer.concat([Buffer.from([0,0,0,16,4,210,22,46]), this.config.cancel])); // Send a CancelRequest with our backendKey cancel token.
            this._connection.destroy(); // Disconnect socket.
            return this._queryHandlers[0].resolve(); // Tell the cancel promise that we're done here.
        }
        this._connection.on('data', this.onData.bind(this)); // Start listening to what the server is saying.
        let chunks = [Buffer.from([0,0,0,0,0,3,0,0])]; // Startup message for protocol version 3.0, we fill in the first four message-length bytes later.
        for (let n in this.config) if (n !== 'password') chunks.push(Buffer.from(`${n}\0${this.config[n]}\0`)); // Send config to the server, except for the password. It is handled in the Authentication flow.
        chunks.push(Buffer.alloc(1)); // Send a zero byte to tell the server that there are no more config params.
        const msg = Buffer.concat(chunks); // Turn the chunks into one big message buffer.
        w32(msg, msg.byteLength, 0); // Write the length of the message at the beginning of the message.
        this._connection.write(msg); // Send the startup message to the server.
    }
    onData(buf) { // On receiving data from the server, copy it to a packet. Once the packet is complete, pass it to the protocol parser in processPacket.
        for (let i = 0; i < buf.byteLength;) { // Process all bytes in buf.
            if (this._packet.cmd === 0) this._packet.cmd = buf[i++]; // Set new packet command and advance byte counter.
            else if (this._packet.index < 4) { // Parsing packet length.
                this._packet.head[this._packet.index++] = buf[i++]; // Copy length bytes to header buffer, advancing byte counters.
                if (this._packet.index === 4) { // That was the last length byte.
                    this._packet.length = r32(this._packet.head, 0); // Parse length as int32BE and store for later.
                    this._packet.buf = Buffer.allocUnsafe(this._packet.length + 1); // Allocate a message buffer to receive the rest of the packet.
                    this._packet.buf[0] = this._packet.cmd; // Copy the already received bytes to the start of the buffer.
                    this._packet.buf[1] = this._packet.head[0]; this._packet.buf[2] = this._packet.head[1]; this._packet.buf[3] = this._packet.head[2]; this._packet.buf[4] = this._packet.head[3];
                }
            }
            if (this._packet.index >= 4) { // If the packet header is complete, copy the packet body to the message buffer.
                const copiedBytes = buf.copy(this._packet.buf, this._packet.index+1, i, i + (this._packet.length - this._packet.index)); // Copy buf to _packet.buf, up to the length of the packet + 1 for the command byte.
                this._packet.index += copiedBytes; // Advance byte counters to keep track where in the packet we currently are.
                i += copiedBytes; // Advance loop byte counter by the amount of bytes processed thus far.
                if (this._packet.index === this._packet.length) { // If the packet is complete, process it and get ready for the next packet.
                    this.processPacket(this._packet.buf, this._packet.cmd, this._packet.length, 5, this._queryHandlers[0], this._formatQueue[0]); // Pass packet to protocol parser.
                    this._packet.cmd = this._packet.index = this._packet.length = 0; // Reset the packet.
                }
            }
        }
    }
    processPacket(buf, cmd, length, off, queryHandler, streamFormat) { switch(cmd) { // Process a protocol packet and write it to the output stream if needed.
        case 68: // D -- DataRow -- Writes query result rows to the output stream and tells the output stream how to parse them.
            queryHandler.stream.format = streamFormat; // Set the output stream's data format (either Client.STRING or Client.BINARY.)
            queryHandler.stream.rowParser = queryHandler.parsed.rowParser; // Set the output stream's row data parser.
            queryHandler.stream.write(buf); // Write the DataRow packet to the output stream for further processing.
            break;
        case 100: // CopyData -- Copy data rows are written directly to the output stream.
            queryHandler.stream.write(buf); // Write the CopyData packet to the output stream for further processing.
            break;
        case 84: // T -- RowDescription -- Describes the column names and types of a query result. Parsed into a RowParser and cached. Written to output stream as well.
            queryHandler.parsed.rowParser = new RowParser(buf); // Create new RowParser from the packet and cache it to the current prepared statement.
        case 73: case 72: case 99: // EmptyQueryResponse / CopyOutResponse / CopyDone -- These are written to the output stream for further processing.
            queryHandler.stream.write(buf);
        case 110: case 116: case 49: case 50: case 51: // NoData / ParameterDescription / {Parse,Bind,Close}Complete -- These are ignored.
            break;
        case 67: // C -- CommandComplete -- The last DataRow is followed by a CommandComplete. Written to output stream.
            if (this.inQuery) this.zeroParamCmd(83); // S -- Sync -- In startQuery-getResult partial queries we need to sync after the command is complete, this commits the query's implicit transaction.
            queryHandler.stream.write(buf); // Write the complete to output stream to let it know the query is finished.
            break;
        case 115: case 71: case 87: // PortalSuspended / CopyInResponse / CopyBothResponse -- Two-part query flow messages. Resolve promises and get written to the output stream.
            queryHandler.stream.write(buf); // Pass the results to either query.getResult stream or CopyIn stream.
            this._queryHandlers.shift(); // Advance _queryHandlers (note that the streamFormat is still valid so we don't shift _formatQueue).
            queryHandler.resolve(queryHandler.stream); // Resolve the partial query or CopyInResponse promise.
            break;
        case 90: // Z -- ReadyForQuery -- Done with the current query, resolve it. Received at the start of the connection, after a Sync, or after an Error.
            this.inQuery = null; // End partial query.
            this._queryHandlers.shift(); // Advance query output streams.
            this._formatQueue.shift(); // Advance query formats as well, the next query may have a different format.
            queryHandler.resolve(queryHandler.stream); // Resolve the current query's promise.
            break;
        case 69: // E -- Error -- There was an error in handling the query, reject the current queryHandler promise.
            this._queryHandlers[0] = {resolve: function() {}}; // Error is followed by ReadyForQuery, this will eat that. _formatQueue[0] doesn't require overwriting.
            queryHandler.reject(Error(`${buf[off]} ${buf.toString('utf8', off+1, off+length-4).replace(/\0/g, ' ')}`)); // Reject the current query with the error message from the server.
            break;
        case 83: // S -- ParameterStatus -- Server parameters are received at the start of the connection, but may also arrive at any time.
            const [key, value] = buf.toString('utf8', off, off + length - 5).split('\0'); // Split the parameter into a key-value pair.
            this.serverParameters[key] = value; // Store the received parameters to serverParameters in case they're useful.
            break;
        case 82: // R -- Authentication -- Server either asks us for a password or tells that everything's A-OK, come on in friend.
            const authResult = r32(buf, off); off += 4; // Read the auth message code and deal with it.
            if (authResult === 0) this.authenticationOk = true; // Authentication successful.
            else if (authResult === 3) { // 3 -- AuthenticationCleartextPassword -- Server asks us to send a password in clear text.
                if (this.config.password === undefined) throw Error("No password supplied"); // For which we need a password.
                this.authResponse(Buffer.from(this.config.password + '\0')); // Send auth response with the password terminated by a null byte.
            } else if (authResult === 5) { // 5 -- AuthenticationMD5Password -- Server asks us for a MD5-hashed password.
                if (this.config.password === undefined) throw Error("No password supplied"); // For which we need a password.
                const upHash = crypto.createHash('md5').update(this.config.password).update(this.config.user).digest('hex'); // Hash the password and username.
                const salted = crypto.createHash('md5').update(upHash).update(buf.slice(off, off+4)).digest('hex'); // Then hash that hash with the salt from the server.
                this.authResponse(Buffer.from(`md5${salted}\0`)); // Add md5 to the front and terminate with a null byte, et voila! A complete MD5-hashed password for the auth response.
            } else { this.end(); throw(Error(`Authentication method ${authResult} not supported`)); } // Other auth mechanisms are not implemented.
            break;
        case 78: // NoticeResponse -- Received a notice from the server. Pass it onto an onNotice handler if there is one.
            if (this.onNotice) this.onNotice(buf); // Call any possible onNotice handler with the message buffer.
            break;
        case 65: // NotificationResponse -- Received a notification message from the server. Pass it to a possible onNotification handler.
            if (this.onNotification) this.onNotification(buf); // Call any possible onNotification handler with the message buffer.
            break;
        case 75: // K -- BackendKeyData -- Server sent us a key to use for canceling requests on this connection.
            this.backendKey = Buffer.from(buf.slice(off, off + length - 4)); // Store the key for later use in cancel().
            break;
        case 118: // NegotiateProtocolVersion -- Server requests us to adapt to a different minor protocol version. We won't.
            this.end(); throw(Error('NegotiateProtocolVersion not implemented')); // Terminate connection and bail out.
        case 86: // FunctionCallResponse -- Legacy, not supported, use 'SELECT my_func()' instead. How did you manage to do a FunctionCall in the first place?
            this.end(); throw(Error('FunctionCallResponse not implemented')); // Terminate connection and bail out.
        default: // Unknown command. Our code is broken. Or the server is broken. Anyway, it's not ACID, eject eject eject.
            console.error(cmd, String.fromCharCode(cmd), length, buf.toString('utf8', off, off + length - 4)); // Log the command to stderr.
            this.end(); throw(Error('Unknown message. Protocol state unknown, exiting.')); // Terminate connection and bail out.
    } }
    promise(stream, parsed) { return new Promise((resolve, reject) => this._queryHandlers.push({stream, parsed, resolve, reject})); }
    parseAndDescribe(statementName, statement, types=[]) {
        const strBuf = Buffer.from(`${statementName}\0${statement}\0`);
        const len = 7 + strBuf.byteLength + types.length*4;
        if (len > 2**31) throw Error("Query string too large");
        const describeBuf = Buffer.from(`S${statementName}\0`);
        const msg = Buffer.allocUnsafe(len + 5 + describeBuf.byteLength);
        let off = 0;
        msg[off++] = 80; // P -- Parse
        off = w32(msg, len - 1, off);
        off += strBuf.copy(msg, off);
        off = w16(msg, types.length, off);
        for (let i = 0; i < types.length; i++) off = w32(msg, types[i], off);
        msg[off++] = 68; // D -- Describe
        off = w32(msg, describeBuf.byteLength+4, off);
        off += describeBuf.copy(msg, off);
        this._connection.write(msg);
    }
    _writeExecuteBuf(wbuf, nameBuf, maxRows, off) {
        wbuf[off++] = 69; // E -- Execute
        off = w32(wbuf, nameBuf.byteLength + 8, off);
        off += nameBuf.copy(wbuf, off);
        off = w32(wbuf, maxRows, off);
        return off;
    }
    _bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats) {
        let bytes = portalNameBuf.byteLength + statementNameBuf.byteLength;
        if (values.buf) return (6 + (valueFormats.length * 2) + bytes + values.buf.byteLength);
        else for (let i = 0; i < values.length; i++) if (values[i] !== null) values[i] = Buffer.from(values[i]), bytes += values[i].byteLength;
        return (13 + (valueFormats.length * 2) + (values.length * 4) + bytes);
    }
    _writeBindBuf(wbuf, portalNameBuf, statementNameBuf, values, valueFormats, format) {
        let off = 5; wbuf[0] = 66; // B -- Bind
        off += portalNameBuf.copy(wbuf, off);
        off += statementNameBuf.copy(wbuf, off);
        off = w16(wbuf, valueFormats.length, off);
        for (let i = 0; i < valueFormats.length; i++) off = w16(wbuf, valueFormats[i], off);
        if (values.buf) off += values.buf.copy(wbuf, off, 5);
        else {
            off = w16(wbuf, values.length, off);
            for (let i = 0; i < values.length; i++) {
                if (values[i] === null) off = w32(wbuf, -1, off);
                else off = w32(wbuf, values[i].byteLength, off), off += values[i].copy(wbuf, off);
            }
        }
        off = w16(wbuf, 1, off);
        off = w16(wbuf, format ? 1 : 0, off);
        w32(wbuf, off-1, 1);
        return off;
    }
    bind(portalName, statementName, values=[], format=Client.STRING) {
        const valueFormats = [];
        if (values.buf) valueFormats.push(values.format);
        else for (let i = 0; i < values.length; i++) valueFormats[i] = values[i] instanceof Buffer ? 1 : 0;
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        const msg = Buffer.allocUnsafe(this._bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats));
        this._writeBindBuf(msg, portalNameBuf, statementNameBuf, values, valueFormats, format);
        this._formatQueue.push(format);
        this._connection.write(msg);
    }
    bindExecuteSync(portalName, statementName, maxRows=0, values=[], format=Client.STRING) {
        const valueFormats = [];
        if (values.buf) valueFormats.push(values.format);
        else for (let i = 0; i < values.length; i++) valueFormats[i] = values[i] instanceof Buffer ? 1 : 0;
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        const msg = Buffer.allocUnsafe(this._bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats) + 14 + portalNameBuf.byteLength);
        let off = this._writeBindBuf(msg, portalNameBuf, statementNameBuf, values, valueFormats, format);
        off = this._writeExecuteBuf(msg, portalNameBuf, maxRows, off);
        msg[off] = 83; msg[++off] = 0; msg[++off] = 0; msg[++off] = 0; msg[++off] = 4; // S -- Sync
        this._formatQueue.push(format);
        this._connection.write(msg);
    }
    executeFlush(portalName, maxRows) {
        const portalNameBuf = Buffer.from(portalName + '\0');
        const msg = Buffer.allocUnsafe(14 + portalNameBuf.byteLength);
        let off = this._writeExecuteBuf(msg, portalNameBuf, maxRows, 0);
        msg[off] = 72; msg[++off] = 0; msg[++off] = 0; msg[++off] = 0; msg[++off] = 4; // H -- Flush
        this._connection.write(msg);
    }
    close(type, name) { return this.bufferCmd(67, Buffer.from(type + name + '\0')); } // C -- Close
    authResponse(buffer) { return this.bufferCmd(112, buffer); } // p -- PasswordMessage/GSSResponse/SASLInitialResponse/SASLResponse
    copyData(buffer) { return this.bufferCmd(100, buffer); } // d -- CopyData
    copyFail(buffer) { return this.bufferCmd(102, buffer); } // f -- CopyFail
    bufferCmd(cmd, buffer) {
        const msg = Buffer.allocUnsafe(5 + buffer.byteLength);
        msg[0] = cmd;
        w32(msg, 4 + buffer.byteLength, 1);
        buffer.copy(msg, 5);
        this._connection.write(msg);
    }
    flush()      { return this.zeroParamCmd(72); } // H -- Flush
    terminate()  { return this.zeroParamCmd(88); } // X -- Terminate
    zeroParamCmd(cmd) {
        const msg = Buffer.allocUnsafe(5); msg[0]=cmd; msg[1]=0; msg[2]=0; msg[3]=0; msg[4]=4;
        this._connection.write(msg);
    }
    parseStatement(statement, cacheStatement) {
        let parsed = this._parsedStatements[statement];
        if (!parsed) {
            parsed = {name: cacheStatement ? (this._parsedStatementCount++).toString() : '', rowParser: null};
            if (cacheStatement) this._parsedStatements[statement] = parsed;
            this.parseAndDescribe(parsed.name, statement);
        }
        return parsed;
    }
    startQuery(statement, values=[], format=Client.STRING, cacheStatement=true) {
        this.inQuery = this.parseStatement(statement, cacheStatement);
        this.bind('', this.inQuery.name, values, format);
    }
    getResults(maxCount=0, stream=new RowReader()) { this.executeFlush('', maxCount); return this.promise(stream, this.inQuery); }
    query(statement, values=[], format=Client.STRING, cacheStatement=true, stream=new RowReader()) {
        const parsed = this.parseStatement(statement, cacheStatement);
        this.bindExecuteSync('', parsed.name, 0, values, format);
        return this.promise(stream, parsed);
    }
    copy(statement, values, format=Client.STRING, cacheStatement=true, stream=new CopyReader()) { return this.query(statement, values, format, cacheStatement, stream); }
    copyDone(stream=new CopyReader()) {
        const msg = Buffer.allocUnsafe(10);
        msg[0]=99; msg[1]=0; msg[2]=0; msg[3]=0; msg[4]=4; // c -- CopyDone
        msg[5]=83; msg[6]=0; msg[7]=0; msg[8]=0; msg[9]=4; // S -- Sync
        this._connection.write(msg);
        return this.promise(stream, null);
    } 
    sync(stream=new RowReader()) { this.zeroParamCmd(83); return this.promise(stream, null); }
    cancel() { return new Client({...this.config, cancel: this.backendKey}).connect(this.address, this.host, this.ssl); }
}
Client.STRING = 0;
Client.BINARY = 1;
class RowReader {
    constructor() { this.rows = [], this.cmd = this.oid = this.format = this.rowParser = undefined, this.rowCount = 0; }
    write(buf) { switch(buf[0]) {
        case 68: return this.rows.push(new (this.rowParser[this.format])(buf)); // D -- DataRow
        case 67: // C -- CommandComplete
            const str = buf.toString('utf8', 5, 1 + r32(buf, 1));
            const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^([^\u0000]*)\u0000/);
            return this.cmd = cmd, this.oid = oid, this.rowCount = parseInt(rowCount || 0);
        case 73: return this.cmd = 'EMPTY'; // I -- EmptyQueryResult
        case 115: return this.cmd = 'SUSPENDED'; // s -- PortalSuspended
    } }
}
class CopyReader extends RowReader {
    write(buf, off=0) { switch(buf[off++]) {
        case 100: return this.rows.push(buf.slice(off+4, off + r32(buf, off))); // CopyData
        case 99: return this.cmd = 'COPY'; // CopyDone
        case 71: case 87: case 72: // Copy{In,Both,Out}Response
            this.format = buf[off+4]; off += 5;
            this.columnCount = r16(buf, off); off += 2;
            this.columnFormats = [];
            for (let i = 0; i < this.columnCount; i++) this.columnFormats[i] = r16(buf, off), off += 2;
    } }
}
class RowParser {
    constructor(buf, off=0) {
        this.buf = buf, this.off = off, this.columns = [], this.columnNames = [];
        const columnCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < columnCount; i++) {
            const nameEnd =  buf.indexOf(0, off);
            const name = buf.toString('utf8', off, nameEnd); off = nameEnd + 1;
            const tableOid = r32(buf, off); off += 4;
            const tableColumnIndex = r16(buf, off); off += 2;
            const typeOid = r32(buf, off); off += 4;
            const typeLen = r16(buf, off); off += 2;
            const typeModifier = r32(buf, off); off += 4;
            const binary = r16(buf, off); off += 2;
            const column = { name, tableOid, tableColumnIndex, typeOid, typeLen, typeModifier, binary };
            this.columns.push(column);
        }
        const columns = this.columns;
        this[Client.BINARY] = function(buf) { this.buf = buf; this.columnCount = columnCount; this.format = Client.BINARY; };
        this[Client.BINARY].prototype = {
            parseColumn: function(start, end) { return this.buf.slice(start, end); },
            toArray: function() { 
                let off = 7, buf = this.buf, dst = new Array(columnCount);
                for (let i = 0; i < columnCount; i++) {
                    const columnLength = r32(buf, off); off += 4;
                    if (columnLength >= 0) { dst[i] = this.parseColumn(off, off+columnLength); off += columnLength; }
                    else dst[i] = null;
                }
                return dst;
            },
            toObject: function() {
                let off = 7, buf = this.buf, dst = {};
                for (let i = 0; i < columnCount; i++) {
                    const columnLength = r32(buf, off); off += 4;
                    if (columnLength >= 0) { dst[columns[i].name] = this.parseColumn(off, off+columnLength); off += columnLength; }
                    else dst[columns[i].name] = null;
                }
                return dst;
            }
        };
        for (let i = 0; i < columns.length; i++) {
            let index = i;
            const getter = function() {
                let off = 7, buf = this.buf;
                for (let j = 0; j < index; j++) {
                    const columnLength = r32(buf, off); off += 4;
                    if (columnLength >= 0) off += columnLength;
                }
                const length = r32(buf, off); off += 4;
                return length < 0 ? null : this.parseColumn(off, off+length);
            };
            Object.defineProperty(this[Client.BINARY].prototype, columns[index].name, {get: getter});
            Object.defineProperty(this[Client.BINARY].prototype, index, {get: getter});
        }
        this[Client.STRING] = function(buf) { this.buf = buf; this.columnCount = columnCount; this.format = Client.STRING; };
        this[Client.STRING].prototype = Object.create(this[Client.BINARY].prototype);
        this[Client.STRING].prototype.parseColumn = function(start, end) { return this.buf.toString('utf8', start, end); }
    }
}
module.exports = { Client, RowReader, CopyReader, RowParser };
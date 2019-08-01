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
        this._packet = { buf: null, head: Buffer.alloc(4), cmd: 0, length: 0, idx: 0 }; // Stores the current incoming protocol message.
        this._outStreams = []; // Internal queue of query result handlers, called in order when receiving query results.
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
        else this._formatQueue.splice(0), this._outStreams.splice(0).forEach(s => s.reject(err)); // Clear out the query result handlers and reject them all. 
    }
    onConnect() { // Initiate connection with PostgreSQL server by sending the startup packet.
        if (this.config.cancel) { // Unless this connection is for canceling a long-running request.
            this._connection.write(Buffer.concat([Buffer.from([0,0,0,16,4,210,22,46]), this.config.cancel])); // Send a CancelRequest with our backendKey cancel token.
            this._connection.destroy(); // Disconnect socket.
            return this._outStreams[0].resolve(); // Tell the cancel promise that we're done here.
        }
        let chunks = [Buffer.from([0,0,0,0,0,3,0,0])]; // Startup message for protocol version 3.0, we fill in the first four message-length bytes later.
        for (let n in this.config) if (n !== 'password') chunks.push(Buffer.from(`${n}\0${this.config[n]}\0`)); // Send config params to the server, except for the password. It is handled in the Authentication flow.
        chunks.push(Buffer.alloc(1)); // Send a zero byte to tell the server that there are no more config params.
        const msg = Buffer.concat(chunks); // Turn the chunks into one big message buffer.
        w32(msg, msg.byteLength, 0); // Write the length of the message at the beginning of the message.
        this._connection.write(msg); // Send the startup message to the server.
        this._connection.on('data', this.onData.bind(this)); // Start listening to what the server is saying.
    }
    onData(buf) {
        const packet = this._packet;
        for (var i = 0; i < buf.byteLength;) {
            if (packet.cmd === 0) {
                packet.cmd = buf[i++];
                packet.length = 0;
                packet.index = 0;
            } else if (packet.index < 4) {
                packet.head[packet.index++] = buf[i++];
                if (packet.index === 4) {
                    packet.length = r32(packet.head, 0);
                    packet.buf = Buffer.allocUnsafe(packet.length + 1);
                    packet.buf[0] = packet.cmd; 
                    packet.buf[1] = packet.head[0]; packet.buf[2] = packet.head[1]; packet.buf[3] = packet.head[2]; packet.buf[4] = packet.head[3];
                }
            }
            if (packet.index >= 4) {
                const copiedBytes = buf.copy(packet.buf, packet.index+1, i, i + (packet.length - packet.index));
                packet.index += copiedBytes;
                i += copiedBytes;
                if (packet.index === packet.length) {
                    this.processPacket(packet.buf, packet.cmd, packet.length, 5, this._outStreams[0], this._formatQueue[0]);
                    packet.cmd = 0;
                }
            }
        }
    }
    processPacket(buf, cmd, length, off, outStream, streamFormat) { switch(cmd) {
        case 68: // D -- DataRow
            outStream.stream.format = streamFormat;
            outStream.stream.rowParser = outStream.parsed.rowParser;
            outStream.stream.write(buf);
            break;
        case 100: // CopyData
            outStream.stream.write(buf);
            break;
        case 84: // T -- RowDescription
            outStream.parsed.rowParser = new RowParser(buf);
        case 73: case 72: case 99: // EmptyQueryResponse / CopyOutResponse / CopyDone
            outStream.stream.write(buf);
        case 110: case 116: case 49: case 50: case 51: // NoData / ParameterDescription / {Parse,Bind,Close}Complete
            break;
        case 67: // C -- CommandComplete
            if (this.inQuery) this.zeroParamCmd(83); // S -- Sync
            outStream.stream.write(buf);
            break;
        case 115: case 71: case 87: // PortalSuspended / CopyInResponse / CopyBothResponse
            outStream.stream.write(buf); // Pass the results to either query.getResult stream or CopyIn stream.
            this._outStreams.shift(); // Advance _outStreams (note that the streamFormat is still valid so we don't shift _formatQueue).
            outStream.resolve(outStream.stream); // Resolve the partial query or CopyInResponse promise.
            break;
        case 90: // Z -- ReadyForQuery
            this.inQuery = null;
            this._outStreams.shift();
            this._formatQueue.shift();
            if (outStream) outStream.resolve(outStream.stream);
            break;
        case 69: // E -- Error
            this._outStreams[0] = null; // Error is followed by ReadyForQuery, this will eat that.
            this._formatQueue[0] = null; // Format needs to be eaten too.
            if (outStream) outStream.reject(Error(`${buf[off]} ${buf.toString('utf8', off+1, off+length-4).replace(/\0/g, ' ')}`));
            break;
        case 83: // S -- ParameterStatus
            const [key, value] = buf.toString('utf8', off, off + length - 5).split('\0');
            this.serverParameters[key] = value;
            break;
        case 82: // R -- Authentication
            const authResult = r32(buf, off); off += 4;
            if (authResult === 0) this.authenticationOk = true;
            else if (authResult === 3) { // 3 -- AuthenticationCleartextPassword
                if (this.config.password === undefined) throw Error("No password supplied");
                this.authResponse(Buffer.from(this.config.password + '\0')); 
            } else if (authResult === 5) { // 5 -- AuthenticationMD5Password
                if (this.config.password === undefined) throw Error("No password supplied");
                const upHash = crypto.createHash('md5').update(this.config.password).update(this.config.user).digest('hex');
                const salted = crypto.createHash('md5').update(upHash).update(buf.slice(off, off+4)).digest('hex');
                this.authResponse(Buffer.from(`md5${salted}\0`)); 
            } else { this.end(); throw(Error(`Authentication method ${authResult} not supported`)); }
            break;
        case 78: // NoticeResponse
            if (this.onNotice) this.onNotice(buf);
            break;
        case 65: // NotificationResponse
            if (this.onNotification) this.onNotification(buf);
            break;
        case 75: // K -- BackendKeyData
            this.backendKey = Buffer.from(buf.slice(off, off + length - 4));
            break;
        case 118: // NegotiateProtocolVersion
            this.end(); throw(Error('NegotiateProtocolVersion not implemented'));
        case 86: // FunctionCallResponse -- Legacy, not supported.
            this.end(); throw(Error('FunctionCallResponse not implemented'));
        default:
            console.error(cmd, String.fromCharCode(cmd), length, buf.toString('utf8', off, off + length - 4));
            this.end(); throw(Error('Unknown message. Protocol state unknown, exiting.'));
    } }
    promise(stream, parsed) { return new Promise((resolve, reject) => this._outStreams.push({stream, parsed, resolve, reject})); }
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
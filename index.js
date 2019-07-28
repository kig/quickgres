// Quickgres is a PostgreSQL client library.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const assert = require('assert');

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; }
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; }

function w32(buf, v, off) { // Write 32-bit big-endian int
    buf[off++] = (v >> 24) & 0xFF;
    buf[off++] = (v >> 16) & 0xFF;
    buf[off++] = (v >> 8) & 0xFF;
    buf[off++] = v & 0xFF;
    return off;
}
function w16(buf, v, off) { // Write 16-bit big-endian int
    buf[off++] = (v >> 8) & 0xFF;
    buf[off++] = v & 0xFF;
    return off;
}
function wstr(obj, str, off) { // Write null-terminated string
    let buf = obj._wbuf;
    const strBuf = Buffer.from(str);
    if (buf.byteLength < off + strBuf.byteLength + 1) {
        obj._wbuf = Buffer.allocUnsafe(off + strBuf.byteLength + 1 + 2**20);
        buf.copy(obj._wbuf);
        buf = obj._wbuf;
    }
    off += strBuf.copy(buf, off);
    buf[off++] = 0;
    return off;
}
function wstrLen(obj, str, off) { // Write buffer length, followed by buffer contents
    let buf = obj._wbuf;
    if (str === null) return w32(buf, -1, off);
    const src = Buffer.from(str);
    if (buf.byteLength < off + src.byteLength + 1) {
        obj._wbuf = Buffer.allocUnsafe(off + src.byteLength + 1 + 2**20);
        buf.copy(obj._wbuf);
        buf = obj._wbuf;
    }
    off = w32(buf, src.byteLength, off);
    return off + src.copy(buf, off);
}
function slice(buf, start, end) { // Copying slice, used to work around full sockets not copying write buffers
    const dst = Buffer.allocUnsafe(end - start);
    buf.copy(dst, 0, start, end);
    return dst;
}

class Client {
    constructor(config) {
        assert(config.user, "No 'user' defined in config");
        assert(config.database, "No 'database' defined in config");
        this._parsedStatementCount = 1;
        this._parsedStatements = {};
        this._packet = { buf: Buffer.alloc(2**16), cmd: 0, len: 0, idx: 0 };
        this._wbuf = Buffer.alloc(2**20);
        this._outStreams = [];
        this.authenticationOk = false;
        this.serverParameters = {};
        this.streamExecutor = this.streamExecutor.bind(this);
        this.config = config;
    }
    connect(address, host) {
        this._connection = net.createConnection(address, host);
        this._connection.once('connect', this.onInitialConnect.bind(this));
        return this.streamPromise();
    }
    end() { 
        this.terminate();
        return this._connection.end();
    }
    onError(err) { this._outStreams.splice(0).forEach(s => s.reject(err)); }
    onInitialConnect() {
        if (this.config.ssl) {
            this._connection.once('data', this.onSSLResponse.bind(this));
            w32(this._wbuf, 8, 0);
            w32(this._wbuf, 80877103, 4);  // SSL Request
            this._connection.write(slice(this._wbuf, 0, 8));
        } else {
            this.onConnect();
        }
    }
    onSSLResponse(buffer) {
        if (buffer[0] !== 83) throw Error("Error establishing an SSL connection");
        this._connection = tls.connect({socket: this._connection, ...this.config.ssl}, this.onConnect.bind(this));
    }
    onConnect() {
        this._connection.on('data', this.onData.bind(this));
        this._connection.on('error', this.onError.bind(this));
        let off = 4;
        off = w16(this._wbuf, 3, off); // Protocol major version 3
        off = w16(this._wbuf, 0, off); // Protocol minor version 0
        const filteredKeys = {password: 1, ssl: 1};
        for (let n in this.config) {
            if (filteredKeys[n]) continue;
            off = wstr(this, n, off); // overflow
            off = wstr(this, this.config[n], off); // overflow
        }
        this._wbuf[off++] = 0;
        w32(this._wbuf, off, 0);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    onData(buf) {
        const packet = this._packet;
        for (var i = 0; i < buf.byteLength;) {
            if (packet.cmd === 0) {
                packet.cmd = buf[i++];
                packet.buf[0] = packet.cmd;
                packet.length = 0;
                packet.index = 0;
            } else if (packet.index < 4) {
                packet.buf[++packet.index] = buf[i++];
                if (packet.index === 4) {
                    packet.length = r32(packet.buf, 1);
                    if (packet.buf.byteLength < packet.length+1) {
                        const newBuf = Buffer.allocUnsafe(packet.length+1);
                        packet.buf.copy(newBuf, 0, 0, 5);
                        packet.buf = newBuf;
                    }
                }
            }
            if (packet.index >= 4) {
                const slice = buf.slice(i, i + (packet.length - packet.index));
                slice.copy(packet.buf, packet.index+1);
                packet.index += slice.byteLength;
                i += slice.byteLength;
                if (packet.index === packet.length) {
                    this.processPacket(packet, 5, this._outStreams[0]);
                    packet.cmd = 0;
                }
            }
        }
    }
    processPacket(packet, off, outStream) {
        const { buf, cmd, length } = packet;
        switch (cmd) {
            case 68: // D -- DataRow
                outStream.stream.rowParser = outStream.parsed.rowParser;
                outStream.stream.write(buf.slice(0, length+1));
                break;
            case 100: // CopyData
                outStream.stream.write(buf.slice(0, length+1));
                break;
            case 84: // T -- RowDescription
                outStream.parsed.rowParser = new RowParser(buf);
            case 73: // I -- EmptyQueryResponse
            case 72: // CopyOutResponse
            case 87: // CopyBothResponse
            case 99: // CopyDone
                outStream.stream.write(buf.slice(0, length+1));
            case 110: // NoData
            case 116: // ParameterDescription
            case 49: // 1 -- ParseComplete
            case 50: // 2 -- BindComplete
            case 51: // 3 -- CloseComplete
                break;
            case 67: // C -- CommandComplete
                if (this.inQuery) this._sync();
                outStream.stream.write(buf.slice(0, length+1));
                break;
            case 115: // s -- PortalSuspended
            case 71: // CopyInResponse
                outStream.stream.write(buf.slice(0, length+1));
                this._outStreams.shift();
                outStream.resolve(outStream.stream);
                break;
            case 90: // Z -- ReadyForQuery
                this.inQuery = this.inQueryParsed = null;
                this._outStreams.shift();
                if (outStream) outStream.resolve(outStream.stream);
                break;
            case 69: // E -- Error
                const fieldType = buf[off]; ++off;
                const string = buf.toString('utf8', off, off + length - 5);
                console.error(cmd, String.fromCharCode(cmd), length, fieldType, string);
                this._outStreams.shift();
                if (outStream) outStream.reject(Error(string));
                break;
            case 83: // S -- ParameterStatus
                const kv = buf.toString('utf8', off, off + length - 5)
                const [key, value] = kv.split('\0');
                this.serverParameters[key] = value;
                break;
            case 82: // R -- Authentication
                const authResult = r32(buf, off); off += 4;
                if (authResult === 0) this.authenticationOk = true;
                else if (authResult === 3) { // 3 -- AuthenticationCleartextPassword
                    assert(this.config.password !== undefined, "No password supplied");
                    this.authResponse(Buffer.from(this.config.password + '\0')); 
                } else if (authResult === 5) { // 5 -- AuthenticationMD5Password
                    assert(this.config.password !== undefined, "No password supplied");
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
        }
    }
    streamExecutor(resolve, reject) {
        this._outStreams.push({stream: this._tmpStream, parsed: this._tmpParsed, resolve, reject}); 
        this._tmpParsed = null;
        this._tmpStream = null;
    }
    streamPromise(stream=new ObjectReader(), parsed={name: '', rowParser: null}) {
        this._tmpStream = stream;
        this._tmpParsed = parsed;
        return new Promise(this.streamExecutor);
    }
    parse(statementName, statement, types=[]) {
        let off = 5; this._wbuf[0] = 80; // P -- Parse
        off = wstr(this, statementName, off); // overflow
        off = wstr(this, statement, off); // overflow
        off = w16(this._wbuf, types.length, off); // max 262144 + 2
        for (let i = 0; i < types.length; i++) off = w32(this._wbuf, types[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    bind(portalName, statementName, values=[], valueFormats=[], resultFormats=[]) {
        let off = 5; this._wbuf[0] = 66; // B -- Bind
        off = wstr(this, portalName, off); // overflow
        off = wstr(this, statementName, off); // overflow
        off = w16(this._wbuf, valueFormats.length, off); // max 131072 + 2
        for (let i = 0; i < valueFormats.length; i++) off = w16(this._wbuf, valueFormats[i], off);
        off = w16(this._wbuf, values.length, off);
        for (let i = 0; i < values.length; i++) { // overflow 262144 + 65536 * str
            if (values[i] === null) off = w32(this._wbuf, -1, off);
            else off = wstrLen(this, values[i], off); // overflow
        }
        off = w16(this._wbuf, resultFormats.length, off); // max 131072 + 2
        for (let i = 0; i < resultFormats.length; i++) off = w16(this._wbuf, resultFormats[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    execute(portalName, maxRows=0) {
        const nameBuf = Buffer.from(portalName + '\0');
        const msg = Buffer.allocUnsafe(9 + nameBuf.byteLength);
        msg[0] = 69; // E -- Execute
        w32(msg, nameBuf.byteLength + 8, 1);
        nameBuf.copy(msg, 5);
        w32(msg, maxRows, 5 + nameBuf.byteLength);
        this._connection.write(msg);
    }
    bindExecuteSync(portalName, statementName, maxRows=0, values=[], valueFormats=[], resultFormats=[]) {
        let off = 5; this._wbuf[0] = 66; // B -- Bind
        const nameBuf = Buffer.from(portalName + '\0');
        off += nameBuf.copy(this._wbuf, off); // overflow
        off = wstr(this, statementName, off); // overflow
        off = w16(this._wbuf, valueFormats.length, off); // max 131072 + 2
        for (let i = 0; i < valueFormats.length; i++) off = w16(this._wbuf, valueFormats[i], off);
        off = w16(this._wbuf, values.length, off);
        for (let i = 0; i < values.length; i++) { // overflow 262144 + 65536 * str
            if (values[i] === null) off = w32(this._wbuf, -1, off);
            else off = wstrLen(this, values[i], off); // overflow
        }
        off = w16(this._wbuf, resultFormats.length, off); // max 131072 + 2
        for (let i = 0; i < resultFormats.length; i++) off = w16(this._wbuf, resultFormats[i], off);
        w32(this._wbuf, off-1, 1); // End of Bind
        this._wbuf[off++] = 69; // E -- Execute
        off = w32(this._wbuf, nameBuf.byteLength + 8, off);
        off += nameBuf.copy(this._wbuf, off);
        off = w32(this._wbuf, maxRows, off); // End of Execute
        this._wbuf[off] = 83; this._wbuf[++off] = 0; this._wbuf[++off] = 0; this._wbuf[++off] = 0; this._wbuf[++off] = 4; // S -- Sync
        this._connection.write(slice(this._wbuf, 0, off+1));
    }
    executeFlush(portalName, maxRows) {
        const nameBuf = Buffer.from(portalName + '\0');
        const msg = Buffer.allocUnsafe(14 + nameBuf.byteLength);
        msg[0] = 69; // E -- Execute
        w32(msg, nameBuf.byteLength + 8, 1);
        nameBuf.copy(msg, 5);
        let off = 5 + nameBuf.byteLength;
        off = w32(msg, maxRows, off);
        msg[off] = 72; msg[++off] = 0; msg[++off] = 0; msg[++off] = 0; msg[++off] = 4; // H -- Flush
        this._connection.write(msg);
    }
    close(type, name) { return this.bufferCmd(67, Buffer.from(type + name + '\0')); } // C -- Close
    describeStatement(name) { return this.bufferCmd(68, Buffer.from('S' + name + '\0')); } // D -- Describe, S -- Statement
    describePortal(name) { return this.bufferCmd(68, Buffer.from('P' + name + '\0')); } // D -- Describe, P -- Portal
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
    copyDone(stream=new CopyReader()) {
        const msg = Buffer.allocUnsafe(10);
        msg[0] = 99; msg[1] = 0; msg[2] = 0; msg[3] = 0; msg[4] = 4; // c -- CopyDone
        msg[5] = 83; msg[6] = 0; msg[7] = 0; msg[8] = 0; msg[9] = 4; // S -- Sync
        this._connection.write(msg);
        return this.streamPromise(stream);
    } 
    _sync() { this.zeroParamCmd(83); } // S -- Sync
    sync(stream=new ObjectReader()) {
        this.zeroParamCmd(83); // S -- Sync
        return this.streamPromise(stream);
    }
    flush()      { return this.zeroParamCmd(72); } // H -- Flush
    terminate()  { return this.zeroParamCmd(88); } // X -- Terminate
    zeroParamCmd(cmd) {
        const msg = Buffer.allocUnsafe(5);
        msg[0] = cmd; msg[1] = 0; msg[2] = 0; msg[3] = 0; msg[4] = 4;
        this._connection.write(msg);
    }
    parseStatement(statement, values) {
        let parsed = this._parsedStatements[statement];
        if (!parsed) {
            let name = this._parsedStatementCount.toString();
            this._parsedStatements[statement] = parsed = {name, rowParser: null};
            this._parsedStatementCount++;
            this.parse(name, statement);
            this.describeStatement(name);
        }
        return parsed;
    }

    startQuery(statement, values=[]) {
        this.inQueryParsed = this.parseStatement(statement);
        this.bind('', this.inQueryParsed.name, values);
        this.inQuery = true;
    }
    getResults(maxCount=0, stream=new ObjectReader()) {
        this.executeFlush('', maxCount);
        return this.streamPromise(stream, this.inQueryParsed);
    }
    query(statement, values=[], stream=new ObjectReader()) {
        const parsed = this.parseStatement(statement);
        this.bindExecuteSync('', parsed.name, 0, values);
        return this.streamPromise(stream, parsed);
    }
    copy(statement, values, stream=new CopyReader()) { return this.query(statement, values, stream); }
}

class ObjectReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) {
        if (chunk[0] === 68) this.rows.push(this.rowParser.parse(chunk)); // D -- DataRow
        else if (chunk[0] === 67) this.completes.push(RowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 115) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // s -- PortalSuspended
    }
}
class ArrayReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) { 
        if (chunk[0] === 68) this.rows.push(RowParser.parseArray(chunk)); // D -- DataRow 
        else if (chunk[0] === 67) this.completes.push(RowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 115) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // s -- PortalSuspended
    }
}
class CopyReader {
    constructor() { this.rows = []; }
    write(chunk, off=0) {
        const cmd = chunk[off]; off++;
        const length = r32(chunk, off); off += 4;
        switch(cmd) {
            case 100: // CopyData
                this.rows.push(slice(chunk, off, off + length - 4));
                break;
            case 71: // CopyInResponse
            case 87: // CopyBothResponse
            case 72: // CopyOutResponse
                this.format = chunk[off]; off++;
                this.columnCount = r16(chunk, off); off += 2;
                this.columnFormats = [];
                for (let i = 0; i < this.columnCount; i++) this.columnFormats[i] = r16(chunk, off), off += 2;
                break;
            case 99: // CopyDone
                this.completed = true;
                break;
        }
    }
}

class RowParser {
    constructor(buf) {
        this.fields = [], this.fieldNames = [];
        let off = 5;
        const fieldCount = r16(buf, off); off += 2;
        for (let i = 0; i < fieldCount; i++) {
            const nameEnd =  buf.indexOf(0, off);
            const name = buf.toString('utf8', off, nameEnd); off = nameEnd + 1;
            const tableOid = r32(buf, off); off += 4;
            const tableColumnIndex = r16(buf, off); off += 2;
            const typeOid = r32(buf, off); off += 4;
            const typeLen = r16(buf, off); off += 2;
            const typeModifier = r32(buf, off); off += 4;
            const binary = r16(buf, off); off += 2;
            const field = { name, tableOid, tableColumnIndex, typeOid, typeLen, typeModifier, binary };
            this.fields.push(field);
        }
        this.fieldObj = function() {};
        this.fieldObj.prototype = this.fields.reduce((o,f) => (o[f.name]='', o), {});
    }
    parse(buf, off=0, dst=new this.fieldObj()) {
        const fieldCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < fieldCount; i++) off = RowParser.parseField(buf, off, dst, this.fields[i].name);
        return dst;
    }
}
RowParser.parseComplete = function(buf) {
    const str = buf.toString('utf8', 5, 1 + r32(buf, 1));
    const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^([^\u0000]*)\u0000/);
    return {cmd, oid, rowCount: parseInt(rowCount || 0)};
};
RowParser.parseField = function(buf, off, dst, field) {
    const fieldLength = r32(buf, off); off += 4;
    if (fieldLength < 0) dst[field] = null;
    else dst[field] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
    return off;
}
RowParser.parseArray = function(buf, off=0, dst=[]) {
    const fieldCount = r16(buf, off+5); off += 7;
    for (let i = 0; i < fieldCount; i++) off = RowParser.parseField(buf, off, dst, i);
    return dst;
}

module.exports = { Client, ObjectReader, ArrayReader, CopyReader, RowParser };
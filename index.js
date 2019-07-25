// Quickgres is a PostgreSQL client library.
const net = require('net');
const crypto = require('crypto');
const assert = require('assert');

function md5Auth(user, password, salt) {
    assert(user !== undefined, "No user supplied");
    assert(password !== undefined, "No password supplied");
    assert(salt !== undefined, "No salt supplied");
    const upHash = crypto.createHash('md5').update(password).update(user).digest('hex');
    const salted = crypto.createHash('md5').update(upHash).update(salt).digest('hex');
    return `md5${salted}\0`;
}
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
function wstr(buf, str, off) { // Write null-terminated string
    off += buf.write(str, off);
    buf[off++] = 0;
    return off;
}
function wstrLen(buf, str, off) { // Write buffer length, followed by buffer contents
    if (str === null) return w32(buf, -1, off);
    const src = Buffer.from(str);
    off = w32(buf, src.byteLength, off);
    return off + src.copy(buf, off);
}
function slice(buf, start, end) { // Copying slice, used to work around full sockets not copying write buffers
    const dst = Buffer.allocUnsafe(end-start);
    buf.copy(dst, 0, start, end);
    return dst;
}

class Client {
    constructor(config) {
        this._parsedStatementCount = 1;
        this._parsedStatements = {};
        this._packet = { buf: Buffer.alloc(1e6), cmd: 0, len: 0, idx: 0 };
        this._wbuf = Buffer.alloc(65536);
        this._outStreams = [];
        this._outStreamsStartIndex = 0;
        this.authenticationOk = false;
        this.serverParameters = {};
        this.packetExecutor = this.packetExecutor.bind(this);
        this.streamExecutor = this.streamExecutor.bind(this);
        this.config = config;
    }
    connect(address, host) {
        this._connection = net.createConnection(address, host);
        this._connection.on('connect', this.onConnect.bind(this));
        this._connection.on('data', this.onData.bind(this));
        this._connection.on('error', this.onError.bind(this));
        return new Promise(this.packetExecutor);
    }
    end() { 
        this.terminate();
        return this._connection.end();
    }
    onError(err) {
        let outStream;
        while (outStream = this._outStreams[this._outStreamsStartIndex]) {
            this.advanceOutStreams();
            outStream.reject(err);
        }
    }
    onConnect() {
        let off = 4;
        off = w16(this._wbuf, 3, off); // Protocol major version 3
        off = w16(this._wbuf, 0, off); // Protocol minor version 0
        for (let n in this.config) {
            if (n === 'password') continue;
            off = wstr(this._wbuf, n, off);
            off = wstr(this._wbuf, this.config[n], off);
        }
        this._wbuf[off++] = 0;
        w32(this._wbuf, off, 0);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    onData(buf) {
        const packet = this._packet;
        for (var i = 0; i < buf.byteLength;) {
            if (packet.cmd === 0) {
                packet.cmd = buf[i];
                packet.buf[0] = packet.cmd;
                packet.length = 0;
                packet.index = 0;
                i++;
            } else if (packet.index < 4) {
                packet.length |= (buf[i] << (8 * (3 - packet.index)));
                packet.buf[packet.index+1] = buf[i];
                if (packet.index === 3 && packet.buf.byteLength < packet.length+1)
                    packet.buf = Buffer.allocUnsafe(packet.length+1);  
                packet.index++;
                i++;
            } else {
                const slice = buf.slice(i, i + (packet.length - packet.index));
                slice.copy(packet.buf, packet.index+1);
                packet.index += slice.byteLength;
                i += slice.byteLength;
                if (packet.index === packet.length) {
                    this.processPacket(packet);
                    packet.cmd = 0;
                }
            }
        }
    }
    advanceOutStreams() {
        this._outStreams[this._outStreamsStartIndex] = null;
        this._outStreamsStartIndex++;
        if (this._outStreamsStartIndex === 100) {
            this._outStreamsStartIndex = 0;
            this._outStreams.splice(0, 100);
        }
    }
    processPacket(packet) {
        const { buf, cmd, length } = packet;
        let off = 5;
        const outStream = this._outStreams[this._outStreamsStartIndex];
        switch (cmd) {
            case 68: // D -- DataRow
            case 67: // C -- CommandComplete
            case 73: // I -- EmptyQueryResponse
            case 112: // p -- PortalSuspended
                if (outStream) {
                    if (!outStream.stream.rowParser) outStream.stream.rowParser = this.getRowParser(outStream.statement);
                    outStream.stream.write(buf.slice(0, length+1));
                }
                break;
            case 116: // ParameterDescription
                break;
            case 84: // T -- RowDescription
                if (outStream) {
                    outStream.stream.rowParser = this.getRowParser(outStream.statement, buf);
                    outStream.stream.write(buf.slice(0, length+1));
                }
                break;
            case 86: // FunctionCallResponse
                if (outStream) {
                    this.advanceOutStreams();
                    outStream.stream.write(buf.slice(0, length+1));
                    outStream.resolve(outStream.stream);
                }
                break;
            case 49: // 1 -- ParseComplete
            case 50: // 2 -- BindComplete
            case 51: // 3 -- CloseComplete
                break;
            case 90: // Z -- ReadyForQuery
                if (outStream) {
                    this.advanceOutStreams();
                    outStream.resolve(outStream.stream);
                }
                break;
            case 71: // CopyInResponse
            case 72: // CopyOutResponse
            case 87: // CopyBothResponse
            case 99: // CopyDone
            case 100: // CopyData
            case 118: // NegotiateProtocolVersion
            case 110: // NoData
            case 78: // NoticeResponse
            case 65: // NotificationResponse
                console.error(cmd, String.fromCharCode(cmd), length, buf.toString('utf8', off, off + length - 4));
                break;
            case 69: // E -- Error
                const fieldType = buf[off]; ++off;
                const string = buf.toString('utf8', off, off + length - 5);
                console.error(cmd, String.fromCharCode(cmd), length, fieldType, string);
                if (outStream) {
                    this.advanceOutStreams();
                    outStream.reject(Error(string));
                }
                break;
            case 83: // S -- ParameterStatus
                const kv = buf.toString('utf8', off, off + length - 5)
                const [key, value] = kv.split('\0');
                this.serverParameters[key] = value;
                break;
            case 82: // R -- Authentication
                const authResult = r32(buf, off); off += 4;
                if (authResult === 0) this.authenticationOk = true;
                else if (authResult === 3) this.authResponse(Buffer.from(this.config.password + '\0')); // 3 -- AuthenticationCleartextPassword
                else if (authResult === 5) this.authResponse(Buffer.from(md5Auth(this.config.user, this.config.password, buf.slice(off, off+4)))); // 5 -- AuthenticationMD5Password
                else { this.end(); throw(Error(`Authentication method ${authResult} not supported`)); }
                break;
            case 75: // K -- BackendKeyData
                this.backendKey = Buffer.from(buf.slice(off, off + length - 4));
                break;
            default:
                console.error(cmd, String.fromCharCode(cmd), length, buf.toString('utf8', off, off + length - 4));
        }
    }
    getRowParser(statement, buf) {
        const parsed = this._parsedStatements[statement];
        if (!parsed) return new RowParser(buf);
        if (!parsed.rowParser) parsed.rowParser = new RowParser(buf);
        return parsed.rowParser;
    }
    getParsedStatement(statement) {
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
    packetExecutor(resolve, reject) { this._outStreams.push({resolve, reject}); }
    streamExecutor(resolve, reject) { this._outStreams.push({stream: this._tmpStream, statement: this._tmpStatement, resolve, reject}); }
    streamPromise(stream) {
        this._tmpStream = stream;
        return new Promise(this.streamExecutor);
    }
    parse(statementName, statement, types=[]) {
        let off = 5; this._wbuf[0] = 80; // P -- Parse
        off = wstr(this._wbuf, statementName, off);
        off = wstr(this._wbuf, statement, off);
        off = w16(this._wbuf, types.length, off);
        for (let i = 0; i < types.length; i++) off = w32(this._wbuf, types[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    bind(portalName, statementName, values=[], valueFormats=[], resultFormats=[]) {
        let off = 5; this._wbuf[0] = 66; // B -- Bind
        off = wstr(this._wbuf, portalName, off);
        off = wstr(this._wbuf, statementName, off);
        off = w16(this._wbuf, valueFormats.length, off);
        for (let i = 0; i < valueFormats.length; i++) off = w16(this._wbuf, valueFormats[i], off);
        off = w16(this._wbuf, values.length, off);
        for (let i = 0; i < values.length; i++) {
            if (values[i] === null) this._wbuf[off++] = -1;
            else off = wstrLen(this._wbuf, values[i], off);
        }
        off = w16(this._wbuf, resultFormats.length, off);
        for (let i = 0; i < resultFormats.length; i++) off = w16(this._wbuf, resultFormats[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    execute(portalName, maxRows=0) {
        let off = 5; this._wbuf[0] = 69; // E -- Execute
        off = wstr(this._wbuf, portalName, off);
        off = w32(this._wbuf, maxRows, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    close(type, name) {
        const promise = new Promise(this.packetExecutor);
        let off = 5; this._wbuf[0] = 67; // C -- Close
        this._wbuf[off++] = type;
        off = wstr(this._wbuf, name, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
        return promise;
    }
    describe(type, name)  { 
        let off = 5; this._wbuf[0] = 68; // D -- Describe
        this._wbuf[off++] = type;
        off = wstr(this._wbuf, name, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    describeStatement(name) { return this.describe(83, name); } // S -- Statement
    describePortal(name) { return this.describe(80, name); } // P -- Portal
    functionCall(oid, args=[], argTypes=[], binary=0, promise=new Promise(this.packetExecutor)) {
        let off = 5; this._wbuf[0] = 70; // F -- FunctionCall
        off = w32(this._wbuf, oid, off);
        off = w16(this._wbuf, argTypes.length, off);
        for (let i = 0; i < argTypes.length; i++) off = w16(this._wbuf, argTypes[i], off);
        off = w16(this._wbuf, args.length, off);
        for (let i = 0; i < argTypes.length; i++) off = wstrLen(this._wbuf, args[i], off);
        off = w16(this._wbuf, binary, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
        return promise;
    }
    authResponse(buffer) { return this.bufferCmd(112, buffer); } // p -- PasswordMessage/GSSResponse/SASLInitialResponse/SASLResponse
    copyData(buffer) { return this.bufferCmd(100, buffer); } // d -- CopyData
    copyFail(buffer) { return this.bufferCmd(102, buffer); } // f -- CopyFail
    bufferCmd(cmd, buffer, promise) {
        this._wbuf[0] = cmd;
        w32(this._wbuf, 4 + buffer.byteLength, 1);
        this._connection.write(slice(this._wbuf, 0, 5));
        this._connection.write(buffer);
        return promise;
    }
    copyDone()   { return this.zeroParamCmd(99); } // c -- CopyDone
    flush()      { return this.zeroParamCmd(72, new Promise(this.packetExecutor)); } // H -- Flush
    sync(stream) { return this.zeroParamCmd(83, this.streamPromise(stream)); } // S -- Sync
    terminate()  { return this.zeroParamCmd(88); } // X -- Terminate
    zeroParamCmd(cmd, promise=undefined) {
        this._wbuf[0] = cmd; // S -- Sync
        this._wbuf[1] = this._wbuf[2] = this._wbuf[3] = 0; this._wbuf[4] = 4;
        this._connection.write(slice(this._wbuf, 0, 5));
        return promise;
    }
    simpleQuery(statement, stream=new ObjectReader()) {
        let off = 5; this._wbuf[0] = 81; // Q -- Query
        off = wstr(this._wbuf, statement, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
        return this.streamPromise(stream);
    }
    query(statement, values=[], stream=new ObjectReader()) {
        const statementName = this.getParsedStatement(statement).name;
        this.bind('', statementName, values);
        this.execute('');
        this._tmpStatement = statement;
        return this.sync(stream);
    }
}

class ObjectReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) {
        if (chunk[0] === 68) this.rows.push(this.rowParser.parse(chunk)); // D -- DataRow
        else if (chunk[0] === 67) this.completes.push(this.rowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 112) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // p -- PortalSuspended
    }
}
class ArrayReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) { 
        if (chunk[0] === 68) this.rows.push(this.rowParser.parseArray(chunk)); // D -- DataRow 
        else if (chunk[0] === 67) this.completes.push(this.rowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 112) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // p -- PortalSuspended
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
    parseComplete(buf) {
        const [_, cmd, oid, rowCount] = buf.toString('utf8', 5).match(/^(\S+)( \d+)?( \d+)\u0000/);
        return {cmd, oid, rowCount: parseInt(rowCount)};
    }
    parseField(buf, off, dst, field) {
        const fieldLength = r32(buf, off); off += 4;
        if (fieldLength < 0) dst[field] = null;
        else dst[field] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
        return off;
    }
    parseArray(buf, off=0, dst=[]) {
        const fieldCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < fieldCount; i++) off = this.parseField(buf, off, dst, i);
        return dst;
    }
    parse(buf, off=0, dst=new this.fieldObj()) {
        const fieldCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < fieldCount; i++) off = this.parseField(buf, off, dst, this.fields[i].name);
        return dst;
    }
}

module.exports = { Client, ObjectReader, ArrayReader, RowParser };
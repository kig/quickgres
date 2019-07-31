// Quickgres is a PostgreSQL client library.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const assert = require('assert');

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; }
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; }
function w32(buf, v, off) { buf[off]=(v>>24)&255; buf[off+1]=(v>>16)&255; buf[off+2]=(v>>8)&255; buf[off+3]=v&255; return off+4; }
function w16(buf, v, off) { buf[off]=(v>>8)&255; buf[off+1]=v&255; return off+2;}

class Client {
    constructor(config) {
        assert(config.user && config.database, "You need to provide both 'user' and 'database' in config");
        this._parsedStatementCount = 1;
        this._parsedStatements = {};
        this._packet = { buf: Buffer.alloc(2**16), head: Buffer.alloc(4), cmd: 0, len: 0, idx: 0 };
        this._outStreams = [];
        this.serverParameters = {};
        this.config = config;
    }
    connect(address, host) {
        this.address = address, this.host = host;
        this._connect();
        return this.promise(null, null);
    }
    _connect() {
        this._connection = net.createConnection(this.address, this.host);
        this._connection.once('connect', this.onInitialConnect.bind(this));
        this._connection.on('error', this.onError.bind(this));
    }
    end() { 
        this.terminate();
        return this._connection.end();
    }
    onError(err) {
        if (err.message.startsWith('connect EAGAIN ')) this._connect();
        else this._outStreams.splice(0).forEach(s => s.reject(err));
    }
    onInitialConnect() {
        if (this.config.ssl) {
            this._connection.once('data', this.onSSLResponse.bind(this));
            this._connection.write(Buffer.from([0,0,0,8,4,210,22,47])); // SSL Request
        } else this.onConnect();
    }
    onSSLResponse(buffer) {
        if (buffer[0] !== 83) throw Error("Error establishing an SSL connection");
        this._connection = tls.connect({socket: this._connection, ...this.config.ssl}, this.onConnect.bind(this));
        this._connection.on('error', this.onError.bind(this));
    }
    onConnect() {
        if (this.config.cancel) {
            this._connection.write(Buffer.concat([Buffer.from([0,0,0,16,4,210,22,46]), this.config.cancel])); // CancelRequest
            this._connection.destroy();
            return this._outStreams[0].resolve();
        }
        this._connection.on('data', this.onData.bind(this));
        let chunks = [Buffer.from([0,0,0,0,0,3,0,0])]; // Protocol version 3.0
        const filteredKeys = {password: 1, ssl: 1};
        for (let n in this.config) if (!filteredKeys[n]) chunks.push(Buffer.from(`${n}\0${this.config[n]}\0`));
        chunks.push(Buffer.alloc(1));
        const msg = Buffer.concat(chunks);
        w32(msg, msg.byteLength, 0);
        this._connection.write(msg);
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
                    packet.buf = packet.buf.byteLength >= packet.length + 1 ? packet.buf : Buffer.allocUnsafe(packet.length + 1);
                    packet.buf[0] = packet.cmd; 
                    packet.buf[1] = packet.head[0]; packet.buf[2] = packet.head[1]; packet.buf[3] = packet.head[2]; packet.buf[4] = packet.head[3];
                }
            }
            if (packet.index >= 4) {
                const copiedBytes = buf.copy(packet.buf, packet.index+1, i, i + (packet.length - packet.index));
                packet.index += copiedBytes;
                i += copiedBytes;
                if (packet.index === packet.length) {
                    this.processPacket(packet.buf, packet.cmd, packet.length, 5, this._outStreams[0]);
                    packet.cmd = 0;
                }
            }
        }
    }
    processPacket(buf, cmd, length, off, outStream) { switch(cmd) {
        case 68: // D -- DataRow
            outStream.stream.rowParser = outStream.parsed.rowParser;
            outStream.stream.write(buf.slice(0, length+1));
            break;
        case 100: // CopyData
            outStream.stream.write(buf.slice(0, length+1));
            break;
        case 84: // T -- RowDescription
            outStream.parsed.rowParser = new RowParser(buf);
        case 73: case 72: case 99: // EmptyQueryResponse / CopyOutResponse / CopyDone
            outStream.stream.write(buf.slice(0, length+1));
        case 110: case 116: case 49: case 50: case 51: // NoData / ParameterDescription / {Parse,Bind,Close}Complete
            break;
        case 67: // C -- CommandComplete
            if (this.inQuery) this.zeroParamCmd(83); // S -- Sync
            outStream.stream.write(buf.slice(0, length+1));
            break;
        case 115: case 71: case 87: // PortalSuspended / CopyInResponse / CopyBothResponse
            outStream.stream.write(buf.slice(0, length+1));
            this._outStreams.shift();
            outStream.resolve(outStream.stream);
            break;
        case 90: // Z -- ReadyForQuery
            this.inQuery = null;
            this._outStreams.shift();
            if (outStream) outStream.resolve(outStream.stream);
            break;
        case 69: // E -- Error
            this._outStreams[0] = null; // Error is followed by ReadyForQuery, this will eat that.
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
    } }
    promise(stream, parsed) { return new Promise((resolve, reject) => this._outStreams.push({stream, parsed, resolve, reject})); }
    parseAndDescribe(statementName, statement, types=[]) {
        const strBuf = Buffer.from(`${statementName}\0${statement}\0`);
        const len = 7 + strBuf.byteLength + types.length*4;
        assert(len <= 2**31, "Query string too large");
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
    _bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats, resultFormats) {
        let bytes = portalNameBuf.byteLength + statementNameBuf.byteLength;
        for (let i = 0; i < values.length; i++) if (values[i] !== null) values[i] = Buffer.from(values[i]), bytes += values[i].byteLength;
        return (11 + (valueFormats.length * 2) + (values.length * 4) + bytes + (resultFormats.length * 2));
    }
    _writeBindBuf(wbuf, portalNameBuf, statementNameBuf, values, valueFormats, resultFormats) {
        let off = 5; wbuf[0] = 66; // B -- Bind
        off += portalNameBuf.copy(wbuf, off);
        off += statementNameBuf.copy(wbuf, off);
        off = w16(wbuf, valueFormats.length, off);
        for (let i = 0; i < valueFormats.length; i++) off = w16(wbuf, valueFormats[i], off);
        off = w16(wbuf, values.length, off);
        for (let i = 0; i < values.length; i++) {
            if (values[i] === null) off = w32(wbuf, -1, off);
            else off = w32(wbuf, values[i].byteLength, off), off += values[i].copy(wbuf, off);
        }
        off = w16(wbuf, resultFormats.length, off);
        for (let i = 0; i < resultFormats.length; i++) off = w16(wbuf, resultFormats[i], off);
        w32(wbuf, off-1, 1);
        return off;
    }
    bind(portalName, statementName, values=[], valueFormats=[], resultFormats=[]) {
        values = values.slice();
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        const msg = Buffer.allocUnsafe(this._bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats, resultFormats));
        this._writeBindBuf(msg, portalNameBuf, statementNameBuf, values, valueFormats, resultFormats);
        this._connection.write(msg);
    }
    bindExecuteSync(portalName, statementName, maxRows=0, values=[], valueFormats=[], resultFormats=[]) {
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        const msg = Buffer.allocUnsafe(this._bindBufLength(portalNameBuf, statementNameBuf, values, valueFormats, resultFormats) + 14 + portalNameBuf.byteLength);
        let off = this._writeBindBuf(msg, portalNameBuf, statementNameBuf, values, valueFormats, resultFormats);
        off = this._writeExecuteBuf(msg, portalNameBuf, maxRows, off);
        msg[off] = 83; msg[++off] = 0; msg[++off] = 0; msg[++off] = 0; msg[++off] = 4; // S -- Sync
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
    startQuery(statement, values=[], cacheStatement=true) {
        this.inQuery = this.parseStatement(statement, cacheStatement);
        this.bind('', this.inQuery.name, values);
    }
    getResults(maxCount=0, stream=new ObjectReader()) { this.executeFlush('', maxCount); return this.promise(stream, this.inQuery); }
    query(statement, values=[], stream=new ObjectReader(), cacheStatement=true) {
        const parsed = this.parseStatement(statement, cacheStatement);
        this.bindExecuteSync('', parsed.name, 0, values);
        return this.promise(stream, parsed);
    }
    copy(statement, values, stream=new CopyReader(), cacheStatement=true) { return this.query(statement, values, stream, cacheStatement); }
    copyDone(stream=new CopyReader()) {
        const msg = Buffer.allocUnsafe(10);
        msg[0]=99; msg[1]=0; msg[2]=0; msg[3]=0; msg[4]=4; // c -- CopyDone
        msg[5]=83; msg[6]=0; msg[7]=0; msg[8]=0; msg[9]=4; // S -- Sync
        this._connection.write(msg);
        return this.promise(stream, null);
    } 
    sync(stream=new ObjectReader()) { this.zeroParamCmd(83); return this.promise(stream, null); }
    cancel() { return new Client({...this.config, cancel: this.backendKey}).connect(this.address, this.host); }
}
class RawReader {
    constructor() { this.rows = [], this.cmd = this.oid = this.rowParser = undefined, this.rowCount = 0; }
    parseRow(buf) { return Buffer.from(buf); }
    write(buf) { switch(buf[0]) {
        case 68: return this.rows.push(this.parseRow(buf)); // D -- DataRow
        case 67: // C -- CommandComplete
            const str = buf.toString('utf8', 5, 1 + r32(buf, 1));
            const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^([^\u0000]*)\u0000/);
            return this.cmd = cmd, this.oid = oid, this.rowCount = parseInt(rowCount || 0);
        case 73: return this.cmd = 'EMPTY'; // I -- EmptyQueryResult
        case 115: return this.cmd = 'SUSPENDED'; // s -- PortalSuspended
    } }
}
class ArrayReader extends RawReader { parseRow(buf) { return RowParser.parseArray(buf); } }
class ObjectReader extends RawReader { parseRow(buf) { return this.rowParser.parse(buf); } }
class CopyReader extends RawReader {
    write(buf, off=0) { switch(buf[off++]) {
        case 100: return this.rows.push(Buffer.from(buf.slice(off+4, off + r32(buf, off)))); // CopyData
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
        this.fields = [], this.fieldNames = [];
        const fieldCount = r16(buf, off+5); off += 7;
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
        for (let i = 0; i < fieldCount; i++) {
            const fieldLength = r32(buf, off); off += 4;
            if (fieldLength < 0) dst[this.fields[i].name] = null;
            else dst[this.fields[i].name] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
        }
        return dst;
    }
}
RowParser.parseArray = function(buf, off=0, dst=[]) {
    const fieldCount = r16(buf, off+5); off += 7;
    for (let i = 0; i < fieldCount; i++) {
        const fieldLength = r32(buf, off); off += 4;
        if (fieldLength < 0) dst[i] = null;
        else dst[i] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
    }
    return dst;
};

module.exports = { Client, ObjectReader, ArrayReader, RawReader, CopyReader, RowParser };
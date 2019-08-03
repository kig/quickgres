// Quickgres is a PostgreSQL client library.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; }
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; }
function w32(buf, v, off) { buf[off]=(v>>24)&255; buf[off+1]=(v>>16)&255; buf[off+2]=(v>>8)&255; buf[off+3]=v&255; return off+4; }
function w16(buf, v, off) { buf[off]=(v>>8)&255; buf[off+1]=v&255; return off+2;}

class Client {
    constructor(config) {
        if (!(config.user && config.database)) throw Error("You need to provide both 'user' and 'database' in config");
        this._parsedStatementCount = 1;
        this._parsedStatements = {};
        this._packet = { buf: Buffer.alloc(2**16), head: Buffer.alloc(4), cmd: 0, length: 0, index: 0 };
        this._outStreams = [];
        this.serverParameters = {};
        this.config = config;
    }
    connect(address, host, ssl) {
        this.address = address, this.host = host, this.ssl = ssl;
        this._connect();
        return this.promise(null, null);
    }
    _connect() {
        this._connection = net.createConnection(this.address, this.host);
        this._connection.once('connect', () => {
            if (this.ssl) {
                this._connection.once('data', (buffer) => {
                    if (buffer[0] !== 83) throw Error("Error establishing an SSL connection");
                    this._connection = tls.connect({socket: this._connection, ...this.ssl}, this.onConnect.bind(this));
                    this._connection.on('error', this.onError.bind(this));
                });
                this._connection.write(Buffer.from([0,0,0,8,4,210,22,47])); // SSL Request
            } else this.onConnect();
        });
        this._connection.on('error', this.onError.bind(this));
    }
    end() { this.zeroParamCmd(88); this._connection.destroy(); } // X -- Terminate
    onError(err) {
        if (err.message.startsWith('connect EAGAIN ')) this._connect();
        else this._outStreams.splice(0).forEach(s => s.reject(err));
    }
    onConnect() {
        if (this.config.cancel) {
            this._connection.write(Buffer.concat([Buffer.from([0,0,0,16,4,210,22,46]), this.config.cancel])); // CancelRequest
            this._connection.destroy();
            return this._outStreams[0].resolve();
        }
        this._connection.on('data', this.onData.bind(this));
        let chunks = [Buffer.from([0,0,0,0,0,3,0,0])]; // Protocol version 3.0
        for (let n in this.config) if (n !== 'password') chunks.push(Buffer.from(`${n}\0${this.config[n]}\0`));
        chunks.push(Buffer.alloc(1));
        const msg = Buffer.concat(chunks);
        w32(msg, msg.byteLength, 0);
        this._connection.write(msg);
    }
    onData(buf) {
        const packet = this._packet;
        for (var i = 0; i < buf.byteLength;) {
            if (packet.cmd === 0) packet.cmd = buf[i++];
            else if (packet.index < 4) {
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
                    packet.cmd = packet.index = 0;
                    if (packet.buf.length > 2e6) packet.buf = Buffer.allocUnsafe(0); // Release buffer after large packets.
                }
            }
        }
    }
    processPacket(buf, cmd, length, off, outStream) { switch(cmd) {
        case 68: // D -- DataRow
            outStream.stream.rowParser = outStream.parsed.rowParser;
            return outStream.stream.write(buf);
        case 100: return outStream.stream.write(buf); // CopyData
        case 84: outStream.parsed.rowParser = new RowParser(buf); // T -- RowDescription
        case 73: case 72: case 99: outStream.stream.write(buf); // EmptyQueryResponse / CopyOutResponse / CopyDone
        case 110: case 116: case 49: case 50: case 51: break; // NoData / ParameterDescription / {Parse,Bind,Close}Complete
        case 67: // C -- CommandComplete
            if (this.inQuery) this.zeroParamCmd(83); // S -- Sync
            return outStream.stream.write(buf);
        case 115: case 71: case 87: // PortalSuspended / CopyInResponse / CopyBothResponse
            outStream.stream.write(buf);
            this._outStreams.shift();
            return outStream.resolve(outStream.stream);
        case 90: // Z -- ReadyForQuery
            this.inQuery = null;
            this._outStreams.shift();
            return outStream.resolve(outStream.stream);
        case 69: // E -- Error
            this._outStreams[0] = {resolve: () => {}}; // Error is followed by ReadyForQuery, this will eat that.
            return outStream.reject(Error(`${buf[off]} ${buf.toString('utf8', off+1, off+length-4).replace(/\0/g, ' ')}`));
        case 83: // S -- ParameterStatus
            const [key, value] = buf.toString('utf8', off, off + length - 5).split('\0');
            return this.serverParameters[key] = value;
        case 82: // R -- Authentication
            const authResult = r32(buf, off); off += 4;
            if (authResult === 0) return this.authenticationOk = true;
            if (this.config.password === undefined) throw Error("No password supplied");
            if (authResult === 3) return this.authResponse(Buffer.from(this.config.password + '\0')); // 3 -- AuthenticationCleartextPassword
            if (authResult === 5) { // 5 -- AuthenticationMD5Password
                const upHash = crypto.createHash('md5').update(this.config.password).update(this.config.user).digest('hex');
                const salted = crypto.createHash('md5').update(upHash).update(buf.slice(off, off+4)).digest('hex');
                return this.authResponse(Buffer.from(`md5${salted}\0`)); 
            }
            this.end(); throw(Error(`Authentication method ${authResult} not supported`));
        case 78: return this.onNotice && this.onNotice(buf); // NoticeResponse
        case 65: return this.onNotification && this.onNotification(buf); // NotificationResponse
        case 75: return this.backendKey = Buffer.from(buf.slice(off, off + length - 4)); // K -- BackendKeyData
        case 118: case 86: default: // NegotiateProtocolVersion / FunctionCallResponse / Unknown
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
    _bindBuf(portalNameBuf, statementNameBuf, values, resultFormat, extraBytes=0) {
        const valueFormats = [], bufValues = [];
        let bytes = portalNameBuf.byteLength + statementNameBuf.byteLength;
        for (let i = 0; i < values.length; i++) {
            valueFormats[i] = values[i] instanceof Buffer ? 1 : 0;
            if (values[i] !== null) bufValues[i] = Buffer.from(values[i]), bytes += bufValues[i].byteLength;
            else bufValues[i] = null;
        }
        const msg = Buffer.allocUnsafe((13 + (bufValues.length * 6) + bytes) + extraBytes);
        let off = 5; msg[0] = 66; // B -- Bind
        off += portalNameBuf.copy(msg, off);
        off += statementNameBuf.copy(msg, off);
        off = w16(msg, valueFormats.length, off);
        for (let i = 0; i < valueFormats.length; i++) off = w16(msg, valueFormats[i], off);
        off = w16(msg, bufValues.length, off);
        for (let i = 0; i < bufValues.length; i++) {
            if (bufValues[i] === null) off = w32(msg, -1, off);
            else off = w32(msg, bufValues[i].byteLength, off), off += bufValues[i].copy(msg, off);
        }
        off = w32(msg, 0x00010000 | resultFormat, off);
        w32(msg, off-1, 1);
        return {msg, off};
    }
    bind(portalName, statementName, values=[], resultFormat=0) {
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        const {msg, off} = this._bindBuf(portalNameBuf, statementNameBuf, values, resultFormat, 0);
        this._connection.write(msg);
    }
    bindExecuteSync(portalName, statementName, maxRows=0, values=[], resultFormat=0) {
        const portalNameBuf = Buffer.from(portalName + '\0');
        const statementNameBuf = Buffer.from(statementName + '\0');
        let {msg, off} = this._bindBuf(portalNameBuf, statementNameBuf, values, resultFormat, 14 + portalNameBuf.byteLength);
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
        msg[0] = cmd; w32(msg, 4 + buffer.byteLength, 1);
        buffer.copy(msg, 5);
        this._connection.write(msg);
    }
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
    startQuery(statement, values=[], resultFormat=0, cacheStatement=true) {
        this.inQuery = this.parseStatement(statement, cacheStatement);
        this.inQueryResultFormat = resultFormat ? 1 : 0;
        this.bind('', this.inQuery.name, values, resultFormat);
    }
    getResults(maxCount=0, stream=new Result()) {
        stream.binary = this.inQueryResultFormat;
        this.executeFlush('', maxCount);
        return this.promise(stream, this.inQuery);
    }
    query(statement, values=[], resultFormat=0, cacheStatement=true, stream=new Result()) {
        stream.binary = resultFormat ? 1 : 0;
        const parsed = this.parseStatement(statement, cacheStatement);
        this.bindExecuteSync('', parsed.name, 0, values, resultFormat);
        return this.promise(stream, parsed);
    }
    copyDone(stream=new Result()) {
        const msg = Buffer.allocUnsafe(10);
        msg[0]=99; msg[1]=0; msg[2]=0; msg[3]=0; msg[4]=4; // c -- CopyDone
        msg[5]=83; msg[6]=0; msg[7]=0; msg[8]=0; msg[9]=4; // S -- Sync
        this._connection.write(msg);
        return this.promise(stream, null);
    } 
    sync(stream=new Result()) { this.zeroParamCmd(83); return this.promise(stream, null); }
    cancel() { return new Client({...this.config, cancel: this.backendKey}).connect(this.address, this.host, this.ssl); }
}
class Result {
    constructor() { this.rows = [], this.cmd = this.oid = this.rowParser = undefined, this.rowCount = 0; }
    write(buf, off=0) { switch(buf[off++]) {
        case 68: 
            buf = this.binary === 0 ? buf : Buffer.from(buf.slice(off-1, off + r32(buf, off)));
            return this.rows.push(this.rowParser.parse(buf, off+6, [], this.binary)); // D -- DataRow
        case 100: return this.rows.push(Buffer.from(buf.slice(off+4, off + r32(buf, off)))); // CopyData
        case 67: // C -- CommandComplete
            const str = buf.toString('utf8', off+4, off + r32(buf, off));
            const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^([^\u0000]*)\u0000/);
            return this.cmd = cmd, this.oid = oid, this.rowCount = parseInt(rowCount || 0);
        case 73: return this.cmd = 'EMPTY'; // I -- EmptyQueryResult
        case 115: return this.cmd = 'SUSPENDED'; // s -- PortalSuspended
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
        this.fields = []; this.fieldCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < this.fieldCount; i++) {
            const nameEnd = buf.indexOf(0, off);
            const name = buf.toString('utf8', off, nameEnd); off = nameEnd + 1;
            const tableOid = r32(buf, off); off += 4;
            const tableColumnIndex = r16(buf, off); off += 2;
            const typeOid = r32(buf, off); off += 4;
            const typeLen = r16(buf, off); off += 2;
            const typeModifier = r32(buf, off); off += 4;
            const binary = r16(buf, off); off += 2;
            const field = { name, tableOid, tableColumnIndex, typeOid, typeLen, typeModifier, binary };
            this.fields[i] = field;
        }
    }
    parse(buf, off, dst, binary) {
        for (let i = 0; i < this.fieldCount; i++) {
            const fieldLength = r32(buf, off); off += 4;
            if (fieldLength < 0) dst[i] = null;
            else if (binary === 0) dst[i] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
            else dst[i] = buf.slice(off, off + fieldLength), off += fieldLength;
        }
        return dst;
    }
}
module.exports = { Client, Result, RowParser };
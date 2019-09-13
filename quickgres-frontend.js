// Quickgres browser library to parse raw PostgreSQL protocol (why do it on the server...)

import { Buffer } from 'buffer';

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; } // Read a 32-bit big-endian int from buffer buf at offset off.
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; } // Read a 16-bit big-endian int from buffer buf at offset off.
// function w32(buf, v, off) { buf[off]=(v>>24)&255; buf[off+1]=(v>>16)&255; buf[off+2]=(v>>8)&255; buf[off+3]=v&255; return off+4; } // Write a 32-bit big-endian int to buffer at offset and return the offset after it.
// function w16(buf, v, off) { buf[off]=(v>>8)&255; buf[off+1]=v&255; return off+2;} // Write a 16-bit big-endian int to buffer at offset and return the offset after it.

export class Client { // The Client class parses PostgreSQL protocol.

    constructor(binary) { // Need to know if it's binary or not, binary is 0 or 1.
        this.stream = new RowReader(); // Create a new RowReader to read in the results
        this.stream.binary = binary; // Set binary 0 or 1 for RowReader.
        this._packet = { buf: null, head: Buffer.alloc(4), cmd: 0, length: 0, index: 0 }; // Stores the current incoming protocol message.
    }

    onData(arrayBuffer) { // On receiving data from the server, copy it to a packet. Once the packet is complete, pass it to the protocol parser in processPacket.
        const buf = Buffer.from(arrayBuffer); // Convert the received ArrayBuffer into a Buffer using https://github.com/feross/buffer
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
                    this.stream.write(this._packet.buf); // Pass packet to protocol parser.
                    this._packet.cmd = this._packet.index = this._packet.length = 0; // Reset the packet.
                }
            }
        }
    }
}


export class RowReader { // RowReader receives query result messages and converts them into query result rows.

    constructor() { this.rows = []; this.cmd = this.oid = this.binary = this.rowParser = undefined; this.rowCount = 0; } // Set up initial state.

    write(buf, off=0) { switch(buf[off++]) { // Receive a PostgreSQL protocol message buffer.
        case 68: this.rows.push(new (this.rowParser[this.binary])(buf)); break; // D -- DataRow -- Parse the row and store it to rows.
        case 100: this.rows.push(buf.slice(off+4, off + r32(buf, off))); break; // CopyData -- Slice the copy message payload and store it to rows.
        case 67: // C -- CommandComplete -- Parse the command complete message and set our completion state.
            const str = buf.toString('utf8', 5, 1 + r32(buf, 1)); // The CommandComplete is a string starting with the completed command name and followed by possible table OID and number of rows affected. 
            // eslint-disable-next-line
            const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^([^\u0000]*)\u0000/); // Parse out the command, table OID and rowCount. This deals with 'CMD oid rowCount', 'CMD rowCount' and 'CMD' cases.
            this.cmd = cmd; this.oid = oid; this.rowCount = parseInt(rowCount || 0); // Store the parsed data and exit.
            break;
        case 73: this.cmd = 'EMPTY'; break; // I -- EmptyQueryResult -- Command completion message for an empty query string.
        case 115: this.cmd = 'SUSPENDED'; break; // s -- PortalSuspended -- Completion message for a result batch from a partial results query.
        case 99: this.cmd = 'COPY'; break; // CopyDone -- Completion message for a copy command.
        case 84: // T -- RowDescription -- Describes the column names and types of a query result. Parsed into a RowParser and cached. Written to output stream as well.
            this.rowParser = new RowParser(buf); // Create new RowParser from the packet and cache it to the current prepared statement.
            break;
        case 71: case 87: case 72: // Copy{In,Both,Out}Response -- Copy response describes the number of columns of the following CopyData messages and their formats (0 = string, 1 = binary.)
            this.format = buf[off+4]; off += 5; // Grab the global format code (0 = string, 1 = binary) and skip the message header.
            this.columnCount = r16(buf, off); off += 2; // Read the number of columns in the copy message.
            this.columnFormats = []; // Store the column formats in an array.
            for (let i = 0; i < this.columnCount; i++) { this.columnFormats[i] = r16(buf, off); off += 2; } // Read the column formats (0 = string, 1 = binary.)
            break;
        default:
    } }
}


export class RowParser { // RowParser parses DataRow buffers into objects and arrays.

    constructor(buf, off=0) { // Create a new RowParser from a DataRow message buffer.
        this.buf = buf; this.off = off; this.columns = []; this.columnNames = []; // Set up parsing state.
        const columnCount = r16(buf, off+5); off += 7; // Read in the array of column descriptions.
        for (let i = 0; i < columnCount; i++) { // Each column has a name, followed by table, type and format info.
            const nameEnd =  buf.indexOf(0, off); // The name is a C string so we find the null byte terminator.
            const name = buf.toString('utf8', off, nameEnd); off = nameEnd + 1; // Then extract the string without the null byte.
            const tableOid = r32(buf, off); off += 4; // If the column is from a table, here's the table's OID. Otherwise zero. 
            const tableColumnIndex = r16(buf, off); off += 2; // Along with the index of the column in the table. If the column is not from a table, this is zero.
            const typeOid = r32(buf, off); off += 4; // Next comes the PostgreSQL data type OID of the column. SELECT typname, oid, typarray FROM pg_type WHERE typarray != 0;
            const typeLen = r16(buf, off); off += 2; // The byteLength of a fixed size type. -1 means variable length type.
            const typeModifier = r32(buf, off); off += 4; // The type modifier, see pg_attribute.atttypmod.
            const binary = r16(buf, off); off += 2; // Whether the column is sent as binary (0 = string, 1 = binary.)
            const column = { name, tableOid, tableColumnIndex, typeOid, typeLen, typeModifier, binary }; // Wrap the column description into an object.
            this.columns.push(column); // And add it to our list of columns.
        }
        const parserPrototype = Object.create(RowParser.parserPrototype); // Create a new row parser prototype.
        parserPrototype.columnCount = columnCount; // Store the number of columns to aid in parsing.
        parserPrototype.rowColumns = this.columns; // Store the column information to find column names and types when parsing.
        for (let i = 0; i < this.columns.length; i++) { // Create column getters.
            const index = i; // Pull index into the local closure.
            const getter = {get: function() { // The getter at this index walks the row columns to find the column data.
                let off = 7, buf = this.rowBuffer; // Set up walk state.
                if (this.columnOffsets === undefined) { // If we haven't cached the column offsets yet, let's do it.
                    this.columnOffsets = new Array(this.columnCount*2); // Lookup table for column offsets and lengths.
                    for (let i = 0; i < this.columnCount; i++) { // Walk through columns.
                        const columnLength = r32(buf, off); off += 4; // Read in the column length.
                        this.columnOffsets[i*2] = off; // Cache column offset.
                        this.columnOffsets[i*2+1] = columnLength; // Cache column length.
                        if (columnLength >= 0) off += columnLength; // Skip over the column data.
                    }
                }
                off = this.columnOffsets[index*2]; // Read the cached column offset
                const length = this.columnOffsets[index*2+1]; // Read the length of the wanted column.
                return length < 0 ? null : this.parseColumn(index, off, off+length); // Parse the column data unless it's a null.
            }};
            Object.defineProperty(parserPrototype, this.columns[index].name, getter); // Bind the getter to the column name so that you can do `col = row.my_col`
            Object.defineProperty(parserPrototype, index, getter); // Bind the getter to the column index so that you can do `col = row[3]`
        }
        this[1] = function(buf) { this.rowBuffer = buf; }; // Binary row constructor just stores the DataRow buffer, it's parsed on access.
        this[1].prototype = Object.create(parserPrototype); // The prototype of the row stores the row description and methods to access columns. Note that all properties are camelCased to avoid name clashes with column names which are all lowercase.
        this[1].prototype.dataFormat = 1; // The binary rows have a binary data format.
        this[1].prototype.parseColumn = function(i, start, end) { // Parse a binary column, casts the column to a JS object.
            const parser = TypeParser[this.rowColumns[i].typeOid]; // Find a parser for the column type.
            return parser ? parser(this.rowBuffer, start, end) : this.rowBuffer.slice(start, end); // If there's a parser, use it, otherwise slice the buffer.
        };
        this[0] = function(buf) { this.rowBuffer = buf; }; // A String row parser is a binary row parser with a different parseColumn method.
        this[0].prototype = Object.create(parserPrototype); // Copy over the binary row prototype.
        this[0].prototype.dataFormat = 0; // The string row parser's data format is string.
        this[0].prototype.parseColumn = function(i, start, end) { return this.rowBuffer.toString('utf8', start, end); } // To parse a string column, convert a slice of the buffer into a string.
    }
}

RowParser.parserPrototype = {

    toArray: function() { // Convert the row into a proper Array.
        let off = 7, buf = this.rowBuffer, dst = new Array(this.columnCount); // Create parsing state and result array.
        for (let i = 0; i < this.columnCount; i++) { // Go through the columns.
            const columnLength = r32(buf, off); off += 4; // Each column has an i32 length, followed by the column data.
            if (columnLength >= 0) { dst[i] = this.parseColumn(i, off, off+columnLength); off += columnLength; } // Store the column data into the result array.
            else dst[i] = null; // If the length is negative, the column is null.
        }
        return dst; // Return the result array.
    },
    
    toObject: function() { // Convert the row into a column name -> column value hash table object.
        let off = 7, buf = this.rowBuffer, dst = {}; // Set up parsing state and result object. Off 7 skips over the header and column count (which we know already.)
        for (let i = 0; i < this.columnCount; i++) { // Go through the columns.
            const columnLength = r32(buf, off); off += 4; // Read the length of the column.
            if (columnLength >= 0) { dst[this.rowColumns[i].name] = this.parseColumn(i, off, off+columnLength); off += columnLength; } // Parse column into result object property.
            else dst[this.rowColumns[i].name] = null; // A negative length means a null value.
        }
        return dst; // Return the result object.
    }
};

const toUtf8 = function(buf) {
    if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(buf);
    } else {
        buf.toString();
    }
};

export const TypeParser = {
    serialize: function(value) {
        if (value instanceof Buffer) return Buffer.from(value);
        const t = typeof value;
        let b;
        if (t === 'boolean') {
            b = Buffer.allocUnsafe(1);
            b[0] = value ? 1 : 0;
        } else if (t === 'number') {
            b = Buffer.allocUnsafe(4);
            if ((value | 0) === value) b.writeInt32BE(value);
            else b.writeFloatBE(value);
        } else if (t === 'bigint') {
            b = Buffer.allocUnsafe(8);
            b.writeBigInt64BE(value);
        } else if (t === 'string') {
            b = Buffer.from(value);
        } else if (t === 'object') {
            b = Buffer.from(JSON.stringify(value));
        }
        return b;
    },
    16: (buf, start, end) => !!buf[start], // bool
    17: (buf, start, end) => buf.slice(start, end), // bytea
    18: (buf, start, end) => buf[start], // char
    19: (buf, start, end) => toUtf8(buf.slice(start, buf.indexOf(0, start))), // name
    20: (buf, start, end) => buf.readBigInt64BE(start), // int8
    21: (buf, start, end) => r16(buf, start), // int2
    // 22 int2vector
    23: (buf, start, end) => r32(buf, start), // int4
    // 24 regproc
    // 1082 date
    // 1083 time
    // 1266 timetz
    1114: (buf, start, end) => { // 1114 timestamp
        const dv = new DataView(buf.buffer.slice(start, end));
        const t = dv.getInt32(0, false);
        const t2 = dv.getInt32(4, false);
        return new Date((t * 4294967.296) + t2 / 1000 + 946656000000);
    },
    1184: (buf, start, end) => { // 1184 timestamptz
        const dv = new DataView(buf.buffer.slice(start, end));
        const t = dv.getInt32(0, false);
        const t2 = dv.getInt32(4, false);
        return new Date((t * 4294967.296) + t2 / 1000 + 946656000000);
    },
    // 1186 interval
    2950: (buf, start, end) => { // 2950 uuid
        const hex = buf.slice(start, end).toString('hex');
        return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    },
    25: (buf, start, end) => toUtf8(buf.slice(start, end)), // text
    26: (buf, start, end) => r32(buf, start), // oid
    114: (buf, start, end) => JSON.parse(toUtf8(buf.slice(start, end))), // json
    142: (buf, start, end) => toUtf8(buf.slice(start, end)), // xml
    700: (buf, start, end) => buf.readFloatBE(start), // float4
    701: (buf, start, end) => buf.readDoubleBE(start), // float8
    1043: (buf, start, end) => toUtf8(buf.slice(start, end)), // varchar
    3802: (buf, start, end) => JSON.parse(toUtf8(buf.slice(start+1, end))) // jsonb
};


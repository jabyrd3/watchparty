'use strict';
// Minimal RFC 6455 WebSocket server.
//
// Hand-rolled because the app directory is mounted read-only, so there is no
// npm install step available. Scope is deliberately narrow: text frames, ping/
// pong, and close. Binary frames are rejected. That is all the chat needs.
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// Anything larger is a protocol abuse for a chat app; close with 1009.
const MAX_FRAME = 64 * 1024;
const PING_INTERVAL_MS = 30000;

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.alive = true;
    this.fragments = null;     // accumulated continuation payloads
    this.fragmentOp = null;
    this.onmessage = () => {};
    this.onclose = () => {};
    // Arbitrary slot for the app to hang state on (see chat.js).
    this.ctx = {};

    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._finish());

    this.pinger = setInterval(() => {
      if (!this.alive) return this.destroy();   // missed a pong round
      this.alive = false;
      this._frame(OP.PING, Buffer.alloc(0));
    }, PING_INTERVAL_MS);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    // A slow-loris style partial frame must not grow without bound.
    if (this.buf.length > MAX_FRAME * 2) return this.close(1009, 'too large');
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handle(frame);
      if (this.closed) break;
    }
  }

  // Returns a parsed frame and consumes it, or null when more bytes are needed.
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) { this.close(1009, 'too large'); return null; }
      len = lo; off += 8;
    }
    if (len > MAX_FRAME) { this.close(1009, 'too large'); return null; }

    // Client-to-server frames must be masked (RFC 6455 §5.1).
    if (!masked) { this.close(1002, 'unmasked'); return null; }
    if (b.length < off + 4) return null;
    const mask = b.subarray(off, off + 4); off += 4;

    if (b.length < off + len) return null;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
    off += len;

    this.buf = b.subarray(off);
    return { fin, opcode, payload };
  }

  _handle(f) {
    switch (f.opcode) {
      case OP.PING:
        return this._frame(OP.PONG, f.payload);
      case OP.PONG:
        this.alive = true;
        return;
      case OP.CLOSE:
        return this.close(1000, '');
      case OP.BINARY:
        return this.close(1003, 'text only');
      case OP.TEXT:
      case OP.CONT: {
        if (f.opcode === OP.TEXT) {
          if (this.fragments) return this.close(1002, 'interleaved');
          if (f.fin) return this._deliver(f.payload);
          this.fragments = [f.payload];
          this.fragmentOp = OP.TEXT;
          return;
        }
        if (!this.fragments) return this.close(1002, 'orphan continuation');
        this.fragments.push(f.payload);
        const total = this.fragments.reduce((n, p) => n + p.length, 0);
        if (total > MAX_FRAME) return this.close(1009, 'too large');
        if (!f.fin) return;
        const full = Buffer.concat(this.fragments);
        this.fragments = null; this.fragmentOp = null;
        return this._deliver(full);
      }
      default:
        return this.close(1002, 'bad opcode');
    }
  }

  _deliver(payload) {
    let text;
    try { text = payload.toString('utf8'); } catch (_) { return this.close(1007, 'bad utf8'); }
    try { this.onmessage(text); } catch (_) { /* handler errors must not kill the socket */ }
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;   // FIN + opcode; server frames are never masked
    try { this.socket.write(Buffer.concat([header, payload])); } catch (_) { this.destroy(); }
  }

  send(text) {
    this._frame(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    const r = Buffer.from(String(reason || ''), 'utf8');
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    this._frame(OP.CLOSE, p);
    try { this.socket.end(); } catch (_) {}
    this._finish();
  }

  destroy() {
    this.closed = true;
    try { this.socket.destroy(); } catch (_) {}
    this._finish();
  }

  _finish() {
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null; }
    if (this._finished) return;
    this._finished = true;
    try { this.onclose(); } catch (_) {}
  }
}

// Completes the opening handshake on an HTTP upgrade and returns a connection.
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  return new WSConnection(socket);
}

module.exports = { accept, WSConnection, MAX_FRAME };

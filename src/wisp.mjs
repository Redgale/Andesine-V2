/**
 * src/wisp.mjs
 *
 * Minimal Wisp v1 server implementation.
 *
 * Wisp is a simple binary framing protocol that multiplexes multiple TCP (or
 * UDP) streams over a single WebSocket.  It is used by the client-side
 * scramjet transport (client/no-sw-inject.js) to proxy WebSocket connections
 * (e.g. for GeForce NOW, gaming services, or any site that uses raw WS).
 *
 * Spec: https://github.com/MercuryWorkshop/wisp-protocol/blob/main/protocol.md
 *
 * Frame wire format:
 *   ┌──────────────┬───────────────┬──────────────────────┐
 *   │ type  [1 B]  │ stream_id [4B]│ payload [variable]   │
 *   └──────────────┴───────────────┴──────────────────────┘
 *
 * Packet types:
 *   0x01  CONNECT   payload: stream_type[1] port[2] hostname[...]
 *   0x02  DATA      payload: raw bytes
 *   0x03  CLOSE     payload: reason[1]  (0=voluntary, 1=network error, 2=addr)
 *   0x05  CONTINUE  payload: buffer_remaining[4]  (flow control, sent S→C)
 *
 * We only support TCP streams (stream_type = 0x01).
 */

import net from 'net';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// Frame encoding / decoding
// ---------------------------------------------------------------------------

const TYPE = {
  CONNECT: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  CONTINUE: 0x05,
};

const CLOSE_REASON = {
  VOLUNTARY: 0x01,
  NETWORK: 0x02,
  BLOCKED: 0x03,
};

const HEADER_SIZE = 5; // type(1) + stream_id(4)
const INITIAL_CONTINUE_BUFFER = 128; // advertise 128 packets of buffer space

/**
 * Read the header and payload from a raw binary WebSocket message.
 * Returns `{ type, streamId, payload }` or null if the frame is malformed.
 */
function parseFrame(data) {
  if (data.length < HEADER_SIZE) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32LE(1);
  const payload = buf.subarray(HEADER_SIZE);
  return { type, streamId, payload };
}

/**
 * Parse a CONNECT payload into `{ streamType, port, hostname }`.
 * The CONNECT payload format is:
 *   stream_type[1]  port[2 LE]  hostname[remainder, utf-8]
 */
function parseConnect(payload) {
  if (payload.length < 4) return null;
  const streamType = payload.readUInt8(0);
  const port = payload.readUInt16LE(1);
  const hostname = payload.subarray(3).toString('utf8');
  return { streamType, port, hostname };
}

/** Build a DATA frame. */
function makeData(streamId, data) {
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt8(TYPE.DATA, 0);
  header.writeUInt32LE(streamId, 1);
  return Buffer.concat([header, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
}

/** Build a CLOSE frame. */
function makeClose(streamId, reason = CLOSE_REASON.VOLUNTARY) {
  const buf = Buffer.allocUnsafe(HEADER_SIZE + 1);
  buf.writeUInt8(TYPE.CLOSE, 0);
  buf.writeUInt32LE(streamId, 1);
  buf.writeUInt8(reason, HEADER_SIZE);
  return buf;
}

/** Build a CONTINUE frame (flow-control, server → client). */
function makeContinue(streamId, bufferRemaining) {
  const buf = Buffer.allocUnsafe(HEADER_SIZE + 4);
  buf.writeUInt8(TYPE.CONTINUE, 0);
  buf.writeUInt32LE(streamId, 1);
  buf.writeUInt32LE(bufferRemaining, HEADER_SIZE);
  return buf;
}

// ---------------------------------------------------------------------------
// Stream management per WebSocket connection
// ---------------------------------------------------------------------------

class WispStream {
  constructor(streamId, tcpSocket, send) {
    this.id = streamId;
    this.tcp = tcpSocket;
    this.send = send; // function(Buffer) → sends a WS frame
    this.closed = false;
  }

  sendData(data) {
    if (this.closed) return;
    this.send(makeData(this.id, data));
    // Replenish flow control window after each packet.
    this.send(makeContinue(this.id, INITIAL_CONTINUE_BUFFER));
  }

  close(reason = CLOSE_REASON.VOLUNTARY) {
    if (this.closed) return;
    this.closed = true;
    this.send(makeClose(this.id, reason));
    this.tcp.destroy();
  }
}

// ---------------------------------------------------------------------------
// Per-WebSocket connection handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming WebSocket connection for the Wisp endpoint.
 *
 * Called with a `ws` (WebSocket instance from the 'ws' library) and the
 * underlying upgrade request.
 */
export function handleWispConnection(ws) {
  ws.binaryType = 'nodebuffer'; // ensure we get Buffers, not ArrayBuffers

  /** Map<streamId, WispStream> */
  const streams = new Map();

  const send = (frame) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
    }
  };

  ws.on('message', (data) => {
    const frame = parseFrame(data);
    if (!frame) return;

    const { type, streamId, payload } = frame;

    switch (type) {
      // ------------------------------------------------------------------
      case TYPE.CONNECT: {
        const info = parseConnect(payload);
        if (!info) return;

        // We only handle TCP streams.
        if (info.streamType !== 0x01) {
          send(makeClose(streamId, CLOSE_REASON.BLOCKED));
          return;
        }

        const { hostname, port } = info;

        // Refuse obviously internal addresses.
        if (isBlockedHost(hostname)) {
          send(makeClose(streamId, CLOSE_REASON.BLOCKED));
          return;
        }

        const tcp = net.createConnection({ host: hostname, port }, () => {
          // Connection established — send an initial CONTINUE to unlock
          // the client's flow control.
          send(makeContinue(streamId, INITIAL_CONTINUE_BUFFER));
        });

        tcp.on('data', (chunk) => {
          const stream = streams.get(streamId);
          if (stream) stream.sendData(chunk);
        });

        tcp.on('close', () => {
          const stream = streams.get(streamId);
          if (stream) {
            stream.closed = true;
            send(makeClose(streamId, CLOSE_REASON.VOLUNTARY));
            streams.delete(streamId);
          }
        });

        tcp.on('error', (err) => {
          console.error(`[wisp] TCP error for stream ${streamId} → ${hostname}:${port}:`, err.message);
          const stream = streams.get(streamId);
          if (stream) {
            stream.closed = true;
            send(makeClose(streamId, CLOSE_REASON.NETWORK));
            streams.delete(streamId);
          }
        });

        streams.set(streamId, new WispStream(streamId, tcp, send));
        break;
      }

      // ------------------------------------------------------------------
      case TYPE.DATA: {
        const stream = streams.get(streamId);
        if (!stream || stream.closed) return;
        stream.tcp.write(payload);
        break;
      }

      // ------------------------------------------------------------------
      case TYPE.CLOSE: {
        const stream = streams.get(streamId);
        if (!stream) return;
        stream.closed = true;
        stream.tcp.destroy();
        streams.delete(streamId);
        break;
      }

      // ------------------------------------------------------------------
      default:
        // Unknown frame type — ignore gracefully.
        break;
    }
  });

  ws.on('close', () => {
    for (const stream of streams.values()) {
      stream.closed = true;
      stream.tcp.destroy();
    }
    streams.clear();
  });

  ws.on('error', (err) => {
    console.error('[wisp] WebSocket error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Blocked-host filter
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

function isBlockedHost(hostname) {
  return BLOCKED_HOSTS.test(hostname);
}

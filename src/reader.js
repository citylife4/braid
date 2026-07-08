// Incremental reader for parsing protocol handshakes from a socket.
// Buffers incoming data and lets async handshake code await exact byte
// counts or delimiters. Call detach() before handing the socket to pipe().
export function createReader(socket) {
  let buffer = Buffer.alloc(0);
  let waiter = null;
  let failure = null;

  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    poke();
  };
  const onError = (err) => {
    failure = err;
    poke();
  };
  const onClose = () => {
    failure ??= new Error('connection closed during handshake');
    poke();
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  function poke() {
    if (!waiter) return;
    const { check, resolve, reject } = waiter;
    let result;
    try {
      result = check();
    } catch (err) {
      waiter = null;
      reject(err);
      return;
    }
    if (result !== undefined) {
      waiter = null;
      resolve(result);
    } else if (failure) {
      waiter = null;
      reject(failure);
    }
  }

  function wait(check) {
    return new Promise((resolve, reject) => {
      waiter = { check, resolve, reject };
      poke();
    });
  }

  return {
    take(n) {
      return wait(() => {
        if (buffer.length < n) return undefined;
        const out = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        return out;
      });
    },

    takeUntil(delimiter, max = 65536) {
      const delim = Buffer.from(delimiter);
      return wait(() => {
        const at = buffer.indexOf(delim);
        if (at === -1) {
          if (buffer.length > max) throw new Error('handshake too large');
          return undefined;
        }
        const out = buffer.subarray(0, at + delim.length);
        buffer = buffer.subarray(at + delim.length);
        return out;
      });
    },

    peek(n) {
      return wait(() => (buffer.length >= n ? buffer.subarray(0, n) : undefined));
    },

    drain() {
      const out = buffer;
      buffer = Buffer.alloc(0);
      return out;
    },

    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

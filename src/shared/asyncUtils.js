function createControllerToken(controller) {
  return {
    get isCancellationRequested() {
      return controller.signal.aborted;
    },
    onCancellationRequested(callback) {
      if (controller.signal.aborted) {
        callback();
        return { dispose() {} };
      }

      controller.signal.addEventListener("abort", callback, { once: true });
      return {
        dispose() {
          controller.signal.removeEventListener("abort", callback);
        }
      };
    }
  };
}

function delay(ms, token, signal) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = [];
    const finish = (callback, value) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      for (const dispose of cleanup) {
        dispose();
      }
      callback(value);
    };
    const timeout = setTimeout(() => finish(resolve), ms);
    const cancel = () => {
      finish(reject, new Error("cancelled"));
    };

    if (token && token.isCancellationRequested) {
      cancel();
      return;
    }

    if (token && typeof token.onCancellationRequested === "function") {
      const disposable = token.onCancellationRequested(cancel);
      cleanup.push(() => disposable.dispose());
    }

    if (signal) {
      if (signal.aborted) {
        cancel();
        return;
      }

      const listener = cancel;
      signal.addEventListener("abort", listener, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", listener));
    }
  });
}

function withTimeout(promise, timeoutMs, controller) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (controller) {
        controller.abort();
      }
      reject(new Error("cancelled"));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

module.exports = {
  createControllerToken,
  delay,
  withTimeout
};
